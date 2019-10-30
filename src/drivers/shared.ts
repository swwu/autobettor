import fs from 'fs';
import puppeteer from 'puppeteer';

interface PasswordInfo {
  [key: string]: {
      username: string,
      password: string}
}

const passwords: PasswordInfo = JSON.parse(fs.readFileSync('passwords.json', 'utf8'));


export interface RawMatchInfo {
  id: string
  // map of player name to odds
  odds: { [key: string]: string }
  // map of player name to index (0 or 1)
  playerIndex: { [key: string] : number }
}

export function convertRawMatchInfos(rawMatchInfos: RawMatchInfo[]): MatchInfo[] {
  let matchInfos: MatchInfo[] = [];
  for (const rawMatchInfo of rawMatchInfos) {
    let newMatchInfo: MatchInfo = {
      id: rawMatchInfo.id,
      odds: {}
    };

    for (const [k, v] of Object.entries(rawMatchInfo.odds)) {
      newMatchInfo.odds[k] = convOddsStr(v);
    }

    matchInfos.push(newMatchInfo);
  }

  return matchInfos;
}

export interface MatchInfo {
  id: string
  // map of player name to odds
  odds: { [key: string]: number }
}

export interface BetsAndBankroll {
  bets: MatchInfo[]
  bankroll: number
}

export function timeout(ms: number): Promise<never> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// convert american-style odds (e.g. +110, -110) to decimal odds (e.g. 2.1,
// 1.909)
export function convOddsStr(odds: string): number {
  const odds_n = parseFloat(odds);
  if (odds[0] == "+" || odds[0] == "-") {
    if (odds_n < 0) {
      return (-odds_n + 100) / -odds_n;
    } else {
      return (odds_n + 100) / 100;
    }
  } else {
    return odds_n;
  }
}

export function parseMoneyStr(money: string): number {
  let moneyStr = money.trim();
  if (moneyStr[0] == "$") moneyStr = moneyStr.substring(1);
  return parseFloat(moneyStr.replace(/,/g, ''))
}

export async function domIsVisible(page: puppeteer.Page, selector: string): Promise<boolean> {
  return await page.evaluate((selector) => {
    const e = document.querySelector(selector);
    if (!e)
      return false;
    const style = window.getComputedStyle(e);
    return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && e.offsetHeight !== 0;
  }, selector);
}

export async function inputGenericAuth(
    page: puppeteer.Page,
    provider: string,
    usernameSelector: string,
    pwSelector: string,
    submitBtnSelector: string) {
  await page.type(usernameSelector, passwords[provider].username);
  await page.type(pwSelector, passwords[provider].password);
  await page.click(submitBtnSelector);
}

export class BaseBetDriver {

  test_mode: boolean;

  constructor(test_mode: boolean) {
    this.test_mode = test_mode;
  }

  loginUrl(): string {
    throw "loginUrl not implemented!";
    return "";
  }

  // Performs authentication at the beginning of the flow.
  async doAuth(page: puppeteer.Page): Promise<void> {
    await page.goto(this.loginUrl());
    await this.handleAuth(page);
    await this.awaitAuthDone(page);
  }

  // Given an in-use page, determine if it needs authenticating and, if so,
  // perform the login
  async handleAuth(page: puppeteer.Page): Promise<void> {
    throw "handleAuth not implemented!";
  }

  // returns a promise that returns when auth is "finished" (i.e. the nav
  // event it triggers is completed). To be called after handleAuth.
  async awaitAuthDone(page: puppeteer.Page): Promise<void> {
    await page.waitForNavigation({waitUntil: "networkidle0"});
  }

  // Given a (driver-specific) section name, navigate to that section. Return
  // true on success, false if failed/impossible (e.g. the section doesn't
  // exist at the moment)
  async navToSection(page: puppeteer.Page, section: string): Promise<boolean> {
    throw "navToSection not implemented!";
    return false;
  }

  // given a page, fetch the bankroll information from it. Generally we assume
  // this is visible from any page we might be on
  async getBankrollFromPage(page: puppeteer.Page): Promise<number> {
    throw "getBankrollFromPage not implemented!";
    return 0;
  }

  // given a page, pull the RawMatchInfo[] for all the matches to be played on
  // that page
  async getRawMatchInfosFromPage(page: puppeteer.Page): Promise<RawMatchInfo[]> {
    throw "getRawMatchInfosFromPage not implemented!";
    return [];
  }

  // returns a promise that returns when the bet data on the page is ready to
  // be parsed (e.g. if the page is ajax-based and we need to watch for a
  // DOM change)
  async awaitBetsReady(page: puppeteer.Page, section: string): Promise<void> {
    throw "awaitBetsReady not implemented!";
  }

  // given a (driver-specific) section, return a MatchInfo[] that shows all
  // the matches in that section
  async getBetsForSection(
      page: puppeteer.Page,
      section: string): Promise<MatchInfo[]> {
    if(!(await this.navToSection(page, section)))
      return [];

    await this.awaitBetsReady(page, section);

    return convertRawMatchInfos(
      await this.getRawMatchInfosFromPage(page));
  }

  // returns a list of all sections for a given kind
  sectionsForKind(kind: string): string[] {
    return (kind == "atp") ? ["atp"] :
      (kind == "wta") ? ["wta"] :
      [];
  }

  async getBetsAndBankroll(
      page: puppeteer.Page,
      kind: string): Promise<BetsAndBankroll> {
    await this.doAuth(page);

    const sections: string[] = this.sectionsForKind(kind);

    // TODO: retry if completely empty (sometimes timing issues happen with
    // await + rendering)
    let matchInfos: MatchInfo[] = [];
    for (let section of sections) {
      matchInfos.push(...await this.getBetsForSection(page, section));
    }

    // doesn't matter where, we're just going there to get the bankroll
    // TODO: make sure this works even when the atp section can't be accessed
    await this.navToSection(page, "atp");
    return {bets: matchInfos, bankroll: await this.getBankrollFromPage(page)};
  }

  async tryBetInSection(
      page: puppeteer.Page,
      section: string,
      betUid: string,
      matchId: string,
      playerKey: string,
      amount: number): Promise<boolean> {
    throw "tryBetInSection not implemented";
    return false
  }

  async makeBet(
      page: puppeteer.Page,
      kind: string,
      betUid: string,
      matchId: string,
      playerKey: string,
      amount: number) {
    await this.doAuth(page);

    const sections: string[] = this.sectionsForKind(kind);

    let succeeded = false;
    for (let section of sections) {
      if (await this.tryBetInSection(page, section, betUid, matchId, playerKey, amount)) {
        succeeded = true;
        break;
      }
    }

    if (!succeeded) {
      throw "no bet was made, most likely invalid bet info: " + matchId + "," + playerKey;
    }
  }
}
