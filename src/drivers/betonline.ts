import puppeteer from 'puppeteer';

import * as shared from './shared';

declare global {
  interface Window {
    __autobettorShared: {
      validateEventNode: (eventNode: HTMLElement) => HTMLElement[] | null;
    };
  }
}

export class BetonlineDriver extends shared.BaseBetDriver {

  loginUrl(): string {
    return 'https://www.betonline.ag/login';
  }

  sectionsForKind(kind: string): string[] {
    return (kind == "atp") ? ["atp", "challenger"] :
      (kind == "wta") ? ["wta"] :
      [];
  }

  // betonline keeps us mostly logged in so we don't ever "skip" auth here
  async handleAuth(page: puppeteer.Page) {
    await page.waitForSelector("#CustomerID");

    await shared.inputGenericAuth(
      page,
      "betonline",
      "#CustomerID",
      "#Password",
      "#button-submit");
  }

  async awaitAuthDone(page: puppeteer.Page): Promise<void> {
    await page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 60000 // betonline auth is slow af
      });
  }

  async navToSection(page: puppeteer.Page, section: string): Promise<boolean> {
    await page.goto("https://www.betonline.ag/sportsbook/tennis/" + section, {
      waitUntil: "networkidle0"
    })
    //await page.waitForSelector(".sportsPeriodTdCol1");
    return true;
  }

  async awaitBetsReady(page: puppeteer.Page, section: string) {
    //await page.waitForSelector(".sportsPeriodTdCol1");
    //await page.waitForSelector("tbody.event td.col_teamname");
    await shared.timeout(500);
  }

  async _insertSharedJs(page: puppeteer.Page) {
    page.evaluate(() => {
      if (window.__autobettorShared) return;

      window.__autobettorShared = {
        // returns a list of (exactly 2) playerRows if they are valid,
        // otherwise returns null
        validateEventNode: function(eventNode: HTMLElement): HTMLElement[] | null {
          // TODO: this is a copy of getRawMatchInfos, find some way to share
          // code inside DOM execution context
          let playerRows: HTMLElement[] = [];
          ["tr.firstline", "tr.otherline"].forEach(function(s) {
            let n = eventNode.querySelector(s);
            if (n) playerRows.push(n as HTMLElement);
          });

          if (playerRows.length != 2) {
            console.log("Bad player rows: " + playerRows);
            return null;
          }

          const firstTeamNode: HTMLElement | null = playerRows[0].querySelector(".col_teamname");
          // we only want the actual match outcome, which is always "Lname, Fname"
          // (most of the props are only lname, e.g. "Lname Sets" or "Lname Double Faults")
          if (firstTeamNode && !firstTeamNode.innerText.includes(","))
            return null;

          return playerRows;
        }
      };
    });
  }

  async getBankrollFromPage(page: puppeteer.Page): Promise<number> {
    await page.waitForSelector("#CurrentBalance");

    const curBalanceStr: string = await page.evaluate(
      () => {
        // Total is third item in the dropdown list
        const balanceNode = document.querySelector("#CurrentBalance");
        if (balanceNode && balanceNode.textContent) {
          return balanceNode.textContent;
        } else { return ""; }
      });

    const pendingBalanceStr: string = await page.evaluate(
      () => {
        // Total is third item in the dropdown list
        const balanceNode = document.querySelector("#PendingWagerBalance");
        if (balanceNode && balanceNode.textContent) {
          return balanceNode.textContent;
        } else { return ""; }
      });

    return shared.parseMoneyStr(curBalanceStr) + shared.parseMoneyStr(pendingBalanceStr);
  }

  async getRawMatchInfosFromPage(page: puppeteer.Page) {
    this._insertSharedJs(page);
    return await page.evaluate(() => {

      let rets: shared.RawMatchInfo[] = [];

      const eventNodes: NodeListOf<HTMLElement> = document.querySelectorAll("tbody.event");

      eventNodes.forEach((eventNode) => {
        const playerRows: HTMLElement[] | null = window.__autobettorShared.validateEventNode(eventNode);
        if (!playerRows) return;

        let matchInfo: shared.RawMatchInfo = {
          id: "",
          outrightOdds: {},
          spreadOddsAdj: {},
          playerIndex: {}
        };

        let names: string[] = [];

        for (let idx=0; idx<playerRows.length; idx++) {
          let playerRow = playerRows[idx];

          const nameNode: HTMLElement | null = playerRow.querySelector("td.col_teamname");
          const outrightNode: HTMLElement | null = playerRow.querySelector("td.moneylineodds");

          if (nameNode && outrightNode) {
            const playerName: string = nameNode.innerText.trim();
            const playerOutrightOdds: string = outrightNode.innerText.trim();

            const spreadOddsNode: HTMLElement | null = <HTMLElement> playerRow.querySelector(".odds.bdevtt");
            const spreadAdjNode: HTMLElement | null = <HTMLElement> playerRow.querySelector(".hdcp.bdevtt");

            names.push(playerName);
            matchInfo.outrightOdds[playerName] = playerOutrightOdds;
            matchInfo.playerIndex[playerName] = idx;

            if (spreadOddsNode && spreadAdjNode) {
              matchInfo.spreadOddsAdj[playerName] = [
                spreadOddsNode.innerText.trim(),
                spreadAdjNode.innerText.trim()];
            }
          } else {
            return;
          }
        }

        names.sort();
        matchInfo.id = names.join("|");

        rets.push(matchInfo);
      });
      return rets;
    });
  }

  async tryBetInSection(
      page: puppeteer.Page,
      section: string,
      betType: string,
      betUid: string,
      matchId: string,
      playerKey: string,
      amount: number): Promise<number> {
    if(!(await this.navToSection(page, section)))
      return 0;

    await this.awaitBetsReady(page, section);

    // clear existing straightbets if we have some for some reason
    while(await page.$("div.cross") !== null) {
      await page.click("div.cross");
    }

    this._insertSharedJs(page);

    const clickNode: puppeteer.ElementHandle = (await page.evaluateHandle((betType, matchId, playerKey) => {

      const eventNodes: NodeListOf<HTMLElement> = document.querySelectorAll("tbody.event");

      let clickNode: HTMLElement | null = null;

      Array.from(eventNodes).some((eventNode, idx): boolean => {
        const playerRows: HTMLElement[] | null = window.__autobettorShared.validateEventNode(eventNode);
        if (!playerRows) return false;

        let names: string[] = [];
        let thisClickElem: HTMLElement | null = null;

        for (let idx=0; idx<playerRows.length; idx++) {
          let playerRow = playerRows[idx];

          const nameNode: HTMLElement | null = playerRow.querySelector("td.col_teamname");
          const oddsNode: HTMLElement | null = (() => {
            if (betType == "gamespread") {
              // technically there are two of these (one for games under/over
              // as well) but this should reliably return the first
              return (<HTMLElement> playerRow.querySelector("td.hdcp"));
            } else if (betType == "outright") {
              return (<HTMLElement> playerRow.querySelector("td.moneylineodds"));
            } else {
              return null;
            }
          })();

          if (nameNode && oddsNode) {
            // if it's blank then the bet doesn't exist, skip it
            const oddsText: string = oddsNode.innerText.trim();
            if (oddsText == "") return false;

            const playerName: string = nameNode.innerText.trim();

            names.push(playerName);
            if (playerName == playerKey) {
              // the clickable checkbox is the element right before the odds
              // label
              thisClickElem = (oddsNode.previousElementSibling as HTMLElement);
            }
          } else {
            return false;
          }
        }

        names.sort();
        const thisId = names.join("|");

        if (thisId == matchId) {
          clickNode = thisClickElem;
          return true;
        } else {
          return false;
        }
      });
      if (clickNode) {
        return clickNode;
      } else {
        throw new Error ("No clicknode found! " + matchId + " " + playerKey);
      }
    }, betType, matchId, playerKey) as puppeteer.ElementHandle);

    await clickNode.click();

    await page.waitForSelector("td.wagertypetd.straighttd.highlight");
    await page.click("td.wagertypetd.straighttd.highlight");

    // fetch max allowed amount
    await page.waitForSelector("a.riskMaxLimitLink");
    // this is required bc a clickhandler is bound to the link in some tick
    // after it gets added to the dom
    await shared.timeout(500);
    await page.click("a.riskMaxLimitLink");

    const maxAmountHandle = await page.waitForFunction(() => {
      var inputNode = <HTMLInputElement> document.querySelector("input.wageramt.risk");
      return inputNode && inputNode.value;
    });

    const maxAmount: number = await maxAmountHandle.evaluate((x: number) => x);

    // clear the textfield again before we try submitting bet
    await page.click("input.wageramt.risk", {clickCount: 3});
    await page.keyboard.press('Backspace');

    // if the bet amount is greater than the maximum risk amount displayed,
    // then bet that amount instead
    amount = Math.min(maxAmount, amount);

    await page.type("input.wageramt.risk", amount.toString());

    await shared.timeout(500);

    await page.click("button#slipSubmit");

    await shared.timeout(1000);

    // TODO: technically this is a security hole because it would allow
    // arbitrary write access to any directory
    await page.screenshot({path: "bet_screenshots/betonline_" + betUid + "_preclick.png"});

    if (!this.test_mode) await page.click("button#slipConfirmBet");

    // let the bet AJAX request resolve
    // TODO: await the confirmation message selector instead
    await shared.timeout(2000);
    await page.screenshot({path: "bet_screenshots/betonline_" + betUid + "_postclick.png"});
    return amount;
  }

}
