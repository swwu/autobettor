import puppeteer from 'puppeteer';

import * as shared from './shared';

const ATP_SECTIONS = ["atp", "atp_qual", "atp_chal"];
const WTA_SECTIONS = ["wta", "wta_qual", "fed_cup", "itf_womens"];

// TODO: worry about wta qual, atp qual, fed cup
const urlPrefixes: { [key:string]: string[] } = {
  "atp": [
    "/en/sports/tennis/atp/",
    "/en/sports/tennis/atp-challenger/"
  ],
  "wta": [
    "/en/sports/tennis/wta/",
    "/en/sports/tennis/itf/"
  ]
}

// See shared.BaseBetDriver for the expected behavior of each method
export class BookmakerDriver extends shared.BaseBetDriver {

  loginUrl(): string { return 'https://bookmaker.eu/'; }

  async sectionsForKind(page: puppeteer.Page, kind: string): Promise<string[]> {
    let prefixes = urlPrefixes[kind];

    const links: string[] = await page.evaluate(
      (prefixes: string[]) => {
        let ret: string[] = [];
        document.querySelectorAll("a[type=league]").forEach(
          (node: Element) => {
            const href = node.getAttribute('href');
            if (href !== null) {
              ret.push(href);
            }
          }
        );

        return ret;
      }, prefixes);

    return links.filter((href: string) =>
      prefixes.some((prefix: string) => href.startsWith(prefix)));
  }

  async handleAuth(page: puppeteer.Page): Promise<void> {
    await page.waitForSelector("#account, a[cat=\"TENNIS\"]");
    if (await page.$("a[cat=\"TENNIS\"]")) { return; }

    await shared.inputGenericAuth(
      page,
      "bookmaker",
      "#account",
      "#password",
      "#loginBox > input[type=\"submit\"]");
  }

  async awaitAuthDone(page: puppeteer.Page): Promise<void> {
    // bookmaker does two redirects in its login, so just wait for the selector
    // to show up instead of waiting for two loads
    await page.waitForSelector("a[cat=\"TENNIS\"]");
  }

  // section is the url of the section
  async navToSection(page: puppeteer.Page, section: string): Promise<boolean> {
    await page.goto("https://be.bookmaker.eu/" + section, {
      waitUntil: "networkidle0"
    })
    return true;
  }

  async awaitBetsReady(page: puppeteer.Page, section: string): Promise<void> {
    await shared.timeout(800);
    await page.waitForSelector("div.schedule-container > app-schedule-league", { timeout: 5000 });

    // this selector exists on the tennis page but not the default football
    // one
    await page.waitForSelector("app-game-mu div.sports-league-game", { timeout: 5000 });
  }

  async getBankrollFromPage(page: puppeteer.Page): Promise<number> {
    await page.waitForSelector("app-player-balance");

    const bankrollRawStr: string = await page.evaluate(
      () => {
        // Total is third item in the dropdown list
        const balanceNode = document.querySelector("a.dropdown-item:nth-child(3)");
        // TODO: actually handle this error
        if (balanceNode && balanceNode.textContent) {
          return balanceNode.textContent;
        }
        else { return ""; }
      });

    if (!bankrollRawStr.startsWith("Total")) {
      throw new Error("balanceNode is not Total, text is: " + bankrollRawStr);
    }
    const bankrollStr: string = bankrollRawStr.split(":")[1];

    return shared.parseMoneyStr(bankrollStr);
  }

  async getRawMatchInfosFromPage(page: puppeteer.Page) {
    return await page.evaluate(() => {

      let rets: shared.RawMatchInfo[] = [];

      let betNodes: NodeListOf<HTMLElement> = document.querySelectorAll("app-game-mu div.sports-league-game");

      betNodes.forEach((betNode) => {
        let gameId = betNode.getAttribute("idgame");

        if (gameId != null) {
          let betCols = betNode.children[0].children;

          // col 0 is time, col 1 is names, col 2 is moneyline odds
          let namesCol = betCols[1];
          let outrightOddsCol = betCols[2];
          let spreadOddsCol = betCols[3];

          let matchInfo: shared.RawMatchInfo = {
            id: gameId,
            outrightOdds: {},
            spreadOddsAdj: {},
            playerIndex: {}
          };

          for (let i=0; i<2; i++) {
            let k = <HTMLElement> namesCol.children[0].children[i];
            let outrightNode = <HTMLElement> outrightOddsCol.children[0].children[0].children[i];
            let spreadNode = <HTMLElement> spreadOddsCol.children[0].children[0].children[i];

            const playerKey = k.innerText;
            matchInfo.outrightOdds[playerKey] = outrightNode.innerText;

            let spreadOddsNode = <HTMLElement> spreadNode.querySelector(".odds");
            let spreadAdjNode = <HTMLElement> spreadNode.querySelector(".points-line");
            if (spreadOddsNode && spreadAdjNode) {
              matchInfo.spreadOddsAdj[playerKey] = [
                spreadOddsNode.innerText,
                spreadAdjNode.innerText];
            }
            matchInfo.playerIndex[playerKey] = i;
          }

          rets.push(matchInfo);
        }
      });
      return rets
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

    try {
      await this.awaitBetsReady(page, section);
    } catch (err) {
      console.log(err); // err should always be TimeoutError here
      return 0;
    }

    const rawMatchInfos: shared.RawMatchInfo[] = await this.getRawMatchInfosFromPage(page);
    const rawMatchInfo = rawMatchInfos.find((e) => e.id === matchId);

    if (rawMatchInfo === undefined) return 0;

    const playerIdx = rawMatchInfo.playerIndex[playerKey];

    if (playerIdx === undefined) return 0;

    const playerOddsSelector = ((): string => {
      if (betType == "gamespread") {
        return ".hdp:nth-child(" + (playerIdx+1) + ")";
      } else if (betType == "outright") {
        return ".mline-" + (playerIdx+1);
      }
      return "NOTHING";
    })();

    // TODO: exception handle misses etc etc

    const clickSelector = "app-game-mu div.sports-league-game[idgame=\"" + matchId + "\"] " + playerOddsSelector;
    await page.waitForSelector(clickSelector);
    await page.click(clickSelector);

    const maxAmountSelector = ".col.bet-limits > a:nth-child(2) .amount";

    await page.waitForSelector(maxAmountSelector);

    let maxAmountStr = "";
    let maxAmount = 0;
    for (let i=0; i<5; i++) {
      maxAmountStr = await page.evaluate((maxAmountSelector: string): string => {
        const maxAmountNode = document.querySelector(maxAmountSelector);
        if (maxAmountNode && maxAmountNode.textContent && maxAmountNode.textContent.trim().length > 0) {
          return maxAmountNode.textContent;
        } else {
          return "";
        }
      }, maxAmountSelector);
      maxAmount = shared.parseMoneyStr(maxAmountStr);

      if (maxAmountStr && !Number.isNaN(maxAmount)) {
        break;
      }

      // this number gets loaded via an ajax call, so retry and wait a few times
      await shared.timeout(200);
    }

    if (!maxAmountStr) {
      throw new Error("Couldn't read max amount node");
    }

    // if the bet amount is greater than the maximum risk amount displayed,
    // then bet that amount instead
    amount = Math.min(maxAmount, amount);

    await page.type(".bet input[aria-label=\"Risk\"]", amount.toString());

    // TODO: technically this is a security hole because it would allow
    // arbitrary write access to any directory
    await page.screenshot({path: "bet_screenshots/bookmaker_" + betUid + "_preclick.png"});

    if (!this.test_mode) {
      await page.click(".place-bet-container button");
      await page.waitForSelector(".bet.success.bet-message");
    }

    await shared.timeout(500);

    await page.screenshot({path: "bet_screenshots/bookmaker_" + betUid + "_postclick.png"});
    return amount;
  }
}
