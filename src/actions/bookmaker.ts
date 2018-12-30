import fs from 'fs';
import puppeteer from 'puppeteer';

interface PasswordInfo {
  username: string
  password: string
}

const timeout = (ms: number) => new Promise(res => setTimeout(res, ms));
const passwords: PasswordInfo = JSON.parse(fs.readFileSync('passwords.json', 'utf8'));

// convert american-style odds (e.g. +110, -110) to decimal odds (e.g. 2.1,
// 1.909)
function conv_odds_str(odds: string): number {
  let odds_n = parseFloat(odds);
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

async function domIsVisible(page: puppeteer.Page, selector: string): Promise<boolean> {
  return await page.evaluate((selector) => {
    const e = document.querySelector(selector);
    if (!e)
      return false;
    const style = window.getComputedStyle(e);
    return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && e.offsetHeight !== 0;
  }, selector);
}

async function handleAuth(page: puppeteer.Page) {
  await page.waitForSelector("#account, a[cat=\"TENNIS\"]");
  if (await page.$("a[cat=\"TENNIS\"]")) { return; }

  await page.type("#account", passwords.username);
  await page.type("#password", passwords.password);
  await page.click("#loginBox > input[type=\"submit\"]");
}

async function navToSection(page: puppeteer.Page, section: string) {

  //bookmaker does two redirects in its login, so just wait for the selector
  //to show up instead of waiting for two loads
  await page.waitForSelector("a[cat=\"TENNIS\"]");

  let btnSelector: string;
  switch (section) {
    case "atp":
      btnSelector = "a#league_12331";
      break;
    case "atp_qual":
      btnSelector = "a#league_13569";
      break;
    case "wta":
      btnSelector = "a#league_12332";
      break;
    case "wta_qual":
      btnSelector = "a#league_13570";
      break;
    default:
      throw "Invalid section: " + section;
  }

  // retry up to three times, since sometimes there's a splash promo that
  // needs dismissing
  for(let i=0; i<3; ++i) {
    try {
      if (!(await domIsVisible(page, btnSelector))) {
        await page.click("a[cat=\"TENNIS\"]");
        await timeout(500);
      }

      await page.waitForSelector(btnSelector, {timeout: 2000});
      await page.click(btnSelector);
      break;
    } catch(e) {
      if (e.message.startsWith("Node is either not visible or not an HTMLElement")) {
        console.log("Couldn't find node, clicking again");
      } else {
        console.log(e);
      }
    }
  }
}

async function doAuth(page: puppeteer.Page) {
  await page.goto('https://bookmaker.eu/');

  await handleAuth(page);
}

export interface MatchInfo {
  id: string
  // map of player name to odds
  odds: { [key: string]: number }
}

interface RawMatchInfo {
  id: string
  // map of player name to odds
  odds: { [key: string]: string }
  // map of player name to index (0 or 1)
  playerIndex: { [key: string] : number }
}

async function getRawMatchInfosFromPage(page: puppeteer.Page) {
  return await page.evaluate(() => {

    var rets: Array<RawMatchInfo> = [];

    var betNodes: NodeListOf<HTMLElement> = document.querySelectorAll("app-game-mu div.sports-league-game");

    betNodes.forEach((betNode) => {
      var gameId = betNode.getAttribute("idgame");

      if (gameId != null) {
        var betCols = betNode.childNodes[0].childNodes;

        // col 0 is time, col 1 is names, col 2 is moneyline odds
        var namesCol = betCols[1];
        var oddsCol = betCols[2];

        var matchInfo: RawMatchInfo = {
          id: gameId,
          odds: {},
          playerIndex: {}
        };

        for (var i=0; i<2; i++) {
          var k = <HTMLElement> namesCol.childNodes[0].childNodes[i];
          var v = <HTMLElement> oddsCol.childNodes[0].childNodes[i];

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

export async function getBankrollFromPage(page: puppeteer.Page) {
  await page.waitForSelector("app-player-balance");

  const bankrollStr: string = await page.evaluate(
    () => {
      // Total is third item in the dropdown list
      const balanceNode = document.querySelector("a.dropdown-item:nth-child(3)");
      // TODO: actually handle this error
      if (balanceNode && balanceNode.textContent) {
        if (!balanceNode.textContent.startsWith("Total")) {
          throw "balanceNode is not Total, text is: " + balanceNode.textContent;
        }
        return balanceNode.textContent.split(":")[1];
      }
      else { return "0"; }
    });

  return parseFloat(bankrollStr.trim().substring(1).replace(/,/g, ''))
}

export interface BetsAndBankroll {
  bets: Array<MatchInfo>
  bankroll: number
}

async function getBetsForSection(page: puppeteer.Page, section: string
    ):Promise<Array<MatchInfo>> {
  await navToSection(page, section);

  await page.waitForSelector("app-game-mu");

  const rawMatchInfos: Array<RawMatchInfo> = await getRawMatchInfosFromPage(page);
  var matchInfos: Array<MatchInfo> = [];
  for (const rawMatchInfo of rawMatchInfos) {
    var newMatchInfo: MatchInfo = {
      id: rawMatchInfo.id,
      odds: {}
    };

    for (const [k, v] of Object.entries(rawMatchInfo.odds)) {
      newMatchInfo.odds[k] = conv_odds_str(v);
    }

    matchInfos.push(newMatchInfo);
  }

  return matchInfos;
}

export async function getBetsAndBankroll(page: puppeteer.Page) {
  await doAuth(page);

  var matchInfos: Array<MatchInfo> = (
    await getBetsForSection(page, "wta")).concat(
    await getBetsForSection(page, "wta_qual"));

  return {bets: matchInfos, bankroll: await getBankrollFromPage(page)};
}

async function tryBetInSection(
    page: puppeteer.Page,
    section: string,
    betUid: string,
    matchId: string,
    playerKey: string,
    amount: number): Promise<boolean> {

  await navToSection(page, section);

  await page.waitForSelector("app-game-mu");

  const rawMatchInfos: Array<RawMatchInfo> = await getRawMatchInfosFromPage(page);
  const rawMatchInfo = rawMatchInfos.find((e) => e.id === matchId);

  if (!rawMatchInfo) return false;

  const playerIdx = rawMatchInfo.playerIndex[playerKey];

  if (!playerIdx) return false;

  const playerOddsSelector = ".mline-" + (playerIdx+1);

  // TODO: exception handle misses etc etc

  const clickSelector = "app-game-mu div.sports-league-game[idgame=\"" + matchId + "\"] " + playerOddsSelector;
  await page.click(clickSelector);
  await page.type(".bet input[aria-label=\"Risk\"]", amount.toString());

  // TODO: technically this is a security hole because it would allow
  // arbitrary write access to any directory
  await page.screenshot({path: "bet_screenshots/" + betUid + ".png"});

  // THIS ACTUALLY PLACES THE BET SO TURN OFF WHILE TESTING
  //await page.click(".place-bet-container button");
  return true
}

export async function makeBet(
    page: puppeteer.Page,
    betUid: string,
    matchId: string,
    playerKey: string,
    amount: number) {
  await doAuth(page);

  if (!(await tryBetInSection(page, "wta", betUid, matchId, playerKey, amount))
      && !(await tryBetInSection(page, "wta_qual", betUid, matchId, playerKey, amount))) {
    throw "no bet was made, most likely invalid bet info: " + matchId + "," + playerKey;
  }
}
