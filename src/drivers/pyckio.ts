
import puppeteer from 'puppeteer';
import request from 'request-promise';

import * as shared from './shared';


let jsonRequest = request.defaults({
  json: true,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/38.0.2125.111 Safari/537.36'
  }
});

const PYCKIO_UNIT_BASIS = 1000;

// See shared.BaseBetDriver for the expected behavior of each method
export class PyckioDriver extends shared.BaseBetDriver {

  loginUrl(): string { return 'https://pyckio.com/signin'; }

  async getPyckioCategoryLeaves(root: string): Promise<string[]> {
    let ret: string[] = [];

    let categoryChildren: any[] = (await jsonRequest(
      'https://api.pyckio.com/categories/' + root + '/children'));

    for (let child of categoryChildren) {
      let cid: string = child['id'];
      if (child['lastCategory'] === true) {
        ret.push(cid);
      } else {
        ret = ret.concat(await this.getPyckioCategoryLeaves(cid));
      }
    }

    return ret;
  }

  async sectionsForKind(page: puppeteer.Page, kind: string): Promise<string[]> {
    let categoryRoot: string = (kind == "atp") ? 'tennis-atp' :
                               (kind == "wta") ? 'tennis-wta' :
                               '';

    return this.getPyckioCategoryLeaves(categoryRoot);
  }

  async handleAuth(page: puppeteer.Page): Promise<void> {
    await page.waitForSelector("input#email, input#pwd");
    if (await page.$("a[cat=\"TENNIS\"]")) { return; }

    await shared.inputGenericAuth(
      page,
      "pyckio",
      "#email",
      "#pwd",
      "button#btn-signin");
  }

  async awaitAuthDone(page: puppeteer.Page): Promise<void> {
    await page.waitForSelector("#auth>.mini-profile");
  }

  // section is usually just "kind", i.e. atp, wta, etc, but also includes quals
  async navToSection(page: puppeteer.Page, section: string): Promise<boolean> {
    await page.goto("https://pyckio.com/i/#!home/" + section, {
      waitUntil: "networkidle0",
      timeout: 60000 // pyckio can be quite slow
    });
    return true;
  }

  async awaitBetsReady(page: puppeteer.Page, section: string): Promise<void> {
    await shared.timeout(800);
    await page.waitForSelector(
      ".items-list.js-category-list > li:not(.item-select) > ul")
  }

  async getBankrollFromPage(page: puppeteer.Page): Promise<number> {
    // this isn't a real bet, instead it's just to normalize staking. We want
    // to capture everything over about 0.001 stake size
    return PYCKIO_UNIT_BASIS;
  }

  async matchInfoForEvent(eventSlug: string): Promise<shared.MatchInfo|null> {
    const eDetails: any = (
      await jsonRequest('https://api.pyckio.com/events/?filter=slug:' + eventSlug))[0];

    if (eDetails['active'] !== true) { return null; }

    const eid: string = eDetails['id'];
    const ePlayers: string[] = eDetails['players'];

    // '12' is name for outrights for some reason
    const eOutrightOddsList = (eDetails['odds']).filter((o: any) => o['name'] === '12');
    if (eOutrightOddsList.length == 0) { return null; }
    const eOutrightOdds = eOutrightOddsList[0];

    let outrightOdds: { [key: string]: number } = {};
    outrightOdds[ePlayers[0]] = eOutrightOdds['data'][0]['price'];
    outrightOdds[ePlayers[1]] = eOutrightOdds['data'][1]['price'];

    return {
      id: eventSlug, // use slug as id since we need to look up bet page with it
      outrightOdds: outrightOdds,
      spreadOddsAdj: {}, // TODO: support spreads
    };
  }

  async getBetsForSection(
      page: puppeteer.Page,
      section: string): Promise<shared.MatchInfo[]> {
    let rets: shared.MatchInfo[] = [];

    // we don't need to actually be on a page for this
    const eventList: any[] = await jsonRequest(
      'https://api.pyckio.com/categories/' + section + '/events')


    return (await Promise.all(
      eventList
          .filter((e: any) => !e.players[0].includes('/'))
          .map((e: any) => this.matchInfoForEvent(e['slug']))))
        .filter((mi: shared.MatchInfo|null) => mi !== null)
        // this last line only exists for type-correctness reasons, and is
        // effectively a noop
        .map((mi: shared.MatchInfo|null): shared.MatchInfo => <shared.MatchInfo>mi);
  }

  async tryBetInSection(
      page: puppeteer.Page,
      section: string,
      betType: string,
      betUid: string,
      matchId: string,
      playerKey: string,
      amount: number): Promise<number> {

    // don't bet if not outright, we only support outrights properly atm
    if (betType != "outright") {
      return 0;
    }

    // matchId is the slug
    await page.goto("https://pyckio.com/i/#!match/" + matchId, {
      waitUntil: "networkidle0",
      timeout: 60000 // pyckio can be quite slow
    });

        //await page.waitForSelector('.js-pinnacle');
        //await page.waitForSelector('.tab-pane.pick-12.active');

    // we scale our value so that 0 is 0 and 0.1*PYCKIO_UNIT_BASIS is 10,
    // then clamp it between 0 and 10
    const betUnits: number = Math.min(10, Math.ceil(amount*10.0*(1/0.1)/PYCKIO_UNIT_BASIS));

    const clickedStake = await page.evaluateHandle((playerKey: string, betUnits: number): boolean => {
      let betPaneNode: HTMLElement|null = <HTMLElement>document.querySelector(
        '.tab-pane.pick-12.active')

      if (!betPaneNode) return false;

      const trNodes = Array.from(betPaneNode.querySelectorAll('tbody[class="1x2"]>tr'));

      for (let trNode of trNodes) {
        // first check that this is the correct row for the player
        const nameNode: HTMLElement|null = <HTMLElement>trNode.querySelector(
          'th[scope=row]');
        if (!nameNode) continue;
        const nameText: string = nameNode.innerText.trim();
        if (nameText != playerKey) continue;

        // then put in the stake yo
        const stakeNode: HTMLElement|null = <HTMLElement>trNode.querySelector(
          '.btn.btn-default.js-stake>input[value="' + betUnits + '"]');

        if (stakeNode) {
          stakeNode.click();
          return true;
        } else {
          return false;
        }
      }
      return false;
    }, playerKey, betUnits);

    if (clickedStake) {
      await page.screenshot({path: "bet_screenshots/pyckio_" + betUid + "_preclick.png"});

      if (!this.test_mode) await page.click('button.js-sendtwip[type="submit"]');

      // let the bet AJAX request resolve
      // TODO: await the confirmation message selector instead; in this case
      // it's slightly strange because pyckio has all 3 possible confirm
      // messages already in the dom with display:none
      await shared.timeout(2000);
      await page.screenshot({path: "bet_screenshots/pyckio_" + betUid + "_postclick.png"});

      return amount;
    } else {
      return 0;
    }
  }
}

