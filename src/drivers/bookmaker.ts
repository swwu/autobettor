import puppeteer from 'puppeteer';

import * as shared from './shared';

const ATP_SECTIONS = ["atp", "atp_qual", "atp_chal"];
const WTA_SECTIONS = ["wta", "wta_qual", "fed_cup", "itf_womens"];


const sectionBtnLabels: { [key:string]: string } = {
  "atp": "a#league_12331",
  "wta": "a#league_12332",
  "atp_qual": "a#league_13569",
  "wta_qual": "a#league_13570",
  "atp_chal": "a#league_13558",
  "fed_cup": "a#league_12575",
  "itf_womens": "a#league_13562"
};

// See shared.BaseBetDriver for the expected behavior of each method
export class BookmakerDriver extends shared.BaseBetDriver {

  loginUrl(): string { return 'https://bookmaker.eu/'; }

  sectionsForKind(kind: string): string[] {
    return (kind == "atp") ? ATP_SECTIONS :
      (kind == "wta") ? WTA_SECTIONS :
      [];
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

  // section is usually just "kind", i.e. atp, wta, etc, but also includes quals
  async navToSection(page: puppeteer.Page, section: string): Promise<boolean> {
    const btnSelector: string = sectionBtnLabels[section];
    if (!btnSelector) throw new Error("Invalid section: " + section);

    // retry up to three times, since sometimes there's a splash promo that
    // needs dismissing
    for(let i=0; i<3; ++i) {
      try {
        if (!(await shared.domIsVisible(page, btnSelector))) {
          await page.click("a[cat=\"TENNIS\"]");
          await shared.timeout(500);
        }

        await page.waitForSelector(btnSelector, {timeout: 2000});
        await shared.timeout(100);
        await page.click(btnSelector);
        break;
      } catch(e) {
        if (e.message.startsWith("Node is either not visible or not an HTMLElement")) {
          console.log("Couldn't find visible menu section node, clicking again");
        } else if (e.message.startsWith("waiting for selector")) {
          console.log("Button doesn't exist, aborting: " + section);
          return false;
        } else {
          console.log(e);
        }
      }
    }

    return true;
  }

  async awaitBetsReady(page: puppeteer.Page, section: string): Promise<void> {
    await shared.timeout(800);
    await page.waitForSelector("div.schedule-container > app-schedule-league");

    // this selector exists on the tennis page but not the default football
    // one
    await page.waitForSelector("app-game-mu div.sports-league-game");
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
          let oddsCol = betCols[2];

          let matchInfo: shared.RawMatchInfo = {
            id: gameId,
            odds: {},
            playerIndex: {}
          };

          for (let i=0; i<2; i++) {
            let k = <HTMLElement> namesCol.children[0].children[i];
            let v = <HTMLElement> oddsCol.children[0].children[0].children[i];

            const playerKey = k.innerText;
            matchInfo.odds[playerKey] = v.innerText;
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
      betUid: string,
      matchId: string,
      playerKey: string,
      amount: number): Promise<boolean> {
    if(!(await this.navToSection(page, section)))
      return false;

    await this.awaitBetsReady(page, section);

    const rawMatchInfos: shared.RawMatchInfo[] = await this.getRawMatchInfosFromPage(page);
    const rawMatchInfo = rawMatchInfos.find((e) => e.id === matchId);

    if (rawMatchInfo === undefined) return false;

    const playerIdx = rawMatchInfo.playerIndex[playerKey];

    if (playerIdx === undefined) return false;

    const playerOddsSelector = ".mline-" + (playerIdx+1);

    // TODO: exception handle misses etc etc

    const clickSelector = "app-game-mu div.sports-league-game[idgame=\"" + matchId + "\"] " + playerOddsSelector;
    await page.click(clickSelector);

    const maxAmountSelector = ".col.bet-limits > a:nth-child(2) .amount";

    await page.waitForSelector(maxAmountSelector);

    let maxAmountStr = "";
    for (let i=0; i<5; i++) {
      maxAmountStr = await page.evaluate((maxAmountSelector: string): string => {
        const maxAmountNode = document.querySelector(maxAmountSelector);
        if (maxAmountNode && maxAmountNode.textContent) {
          return maxAmountNode.textContent;
        } else {
          return "";
        }
      }, maxAmountSelector);

      if (maxAmountStr) {
        break;
      }

      // this number gets loaded via an ajax call, so retry and wait a few times
      await shared.timeout(200);
    }

    if (!maxAmountStr) {
      throw new Error("Couldn't find max amount node");
    }

    const maxAmount = shared.parseMoneyStr(maxAmountStr);

    // if the bet amount is greater than the maximum risk amount displayed,
    // then bet that amount instead
    amount = Math.min(maxAmount, amount);

    await page.type(".bet input[aria-label=\"Risk\"]", amount.toString());

    // TODO: technically this is a security hole because it would allow
    // arbitrary write access to any directory
    await page.screenshot({path: "bet_screenshots/bookmaker_" + betUid + ".png"});

    if (!this.test_mode) await page.click(".place-bet-container button");

    // let the bet AJAX request resolve
    // TODO: await the confirmation message selector instead
    await shared.timeout(1000);
    return true
  }
}
