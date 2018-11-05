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
function conv_odds(odds: number): number {
  if (odds < 0) {
    return (-odds + 100) / -odds;
  } else {
    return (odds + 100) / 100;
  }
}

async function handleAuth(page: puppeteer.Page) {
  await page.waitForSelector("#account, a[cat=\"TENNIS\"]");
	if (await page.$("a[cat=\"TENNIS\"]")) { return; }

  await page.type("#account", passwords.username);
  await page.type("#password", passwords.password);
  await page.click("#loginBox > input[type=\"submit\"]");
}

async function navToBets(page: puppeteer.Page) {
  await page.goto('https://bookmaker.eu/');

  await handleAuth(page);
  //bookmaker does two redirects in its login, so just wait for the selector
  //to show up instead of waiting for two loads
  await page.waitForSelector("a[cat=\"TENNIS\"]");
  await page.click("a[cat=\"TENNIS\"]");
  await timeout(500);
  //await page.waitForSelector("a#league_12331", {
  //  visible: true
  //});
  // ATP
  //await page.click("a#league_12331");
  // WTA
  await page.click("a#league_12332");
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

async function getRawMatchInfos(page: puppeteer.Page) {
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

export async function getBankroll(page: puppeteer.Page) {
  await navToBets(page);
  await page.waitForSelector("app-player-balance");

  const bankrollStr: string = await page.evaluate(
    () => {
      const balanceNode = document.querySelector("app-player-balance");
      // TODO: actually handle this error
      if (balanceNode) { return balanceNode.textContent; }
      else { return "0"; }
    });

  return parseFloat(bankrollStr.substring(1).replace(/,/g, ''))
}

export async function getBets(page: puppeteer.Page) {
  await navToBets(page);
  await page.waitForSelector("app-game-mu");

  const rawMatchInfos: Array<RawMatchInfo> = await getRawMatchInfos(page);
  var matchInfos: Array<MatchInfo> = [];
  for (const rawMatchInfo of rawMatchInfos) {
    var newMatchInfo: MatchInfo = {
      id: rawMatchInfo.id,
      odds: {}
    };

    for (const [k, v] of Object.entries(rawMatchInfo.odds)) {
      newMatchInfo.odds[k] = conv_odds(parseInt(v));
    }

    matchInfos.push(newMatchInfo);
  }

  return matchInfos;
}

export async function makeBet(page: puppeteer.Page, matchId: string, playerKey: string, amount: number) {
  await navToBets(page);
  await page.waitForSelector("app-game-mu");

  const rawMatchInfos: Array<RawMatchInfo> = await getRawMatchInfos(page);
  const rawMatchInfo = rawMatchInfos.find((e) => e.id === matchId);

  if (!rawMatchInfo) return;

  const playerIdx = rawMatchInfo.playerIndex[playerKey];
  const playerOddsSelector = ".mline-" + (playerIdx+1);


  // TODO: exception handle misses etc etc

  const clickSelector = "app-game-mu div.sports-league-game[idgame=\"" + matchId + "\"] " + playerOddsSelector;
  await page.click(clickSelector);
  await page.type(".bet input[aria-label=\"Risk\"]", amount.toString());

  // THIS ACTUALLY PLACES THE BET SO TURN OFF WHILE TESTING
  //await page.click(".place-bet-container button");
}
