import fs from 'fs';
import puppeteer from 'puppeteer';

interface PasswordInfo {
  username: string
  password: string
}

const timeout = (ms: number) => new Promise(res => setTimeout(res, ms));
const passwords: PasswordInfo = JSON.parse(fs.readFileSync('passwords.json', 'utf8'));

export async function handleAuth(page: puppeteer.Page) {
  await page.waitForSelector("#account");
  await page.type("#account", passwords.username);
  await page.type("#password", passwords.password);
  await page.click("#loginBox > input[type=\"submit\"]");
}

export async function navToBets(page: puppeteer.Page) {
  await page.goto('https://www.bookmaker.eu/');

  await handleAuth(page);
  //bookmaker does two redirects in its login, so just wait for the selector
  //to show up instead of waiting for two loads
  await page.waitForSelector("a[cat=\"TENNIS\"]");
  await page.click("a[cat=\"TENNIS\"]");
  await timeout(500);
  //await page.waitForSelector("a#league_12331", {
  //  visible: true
  //});
  await page.click("a#league_12331");
}

interface MatchInfo {
  id: string
  // map of player name to odds
  odds: { [key: string]: number }
}

export async function getBets(page: puppeteer.Page) {
  await navToBets(page);
  await page.waitForSelector("app-game-mu");
  var matchInfos = await page.evaluate(() => {
    // convert american-style odds (e.g. +110, -110) to decimal odds (e.g. 2.1,
    // 1.909)
    function conv_odds(odds: number): number {
      if (odds < 0) {
        return (-odds + 100) / -odds;
      } else {
        return (odds + 100) / 100;
      }
    }

    var rets: Array<MatchInfo> = [];

    var betNodes: NodeListOf<HTMLElement> = document.querySelectorAll("app-game-mu div.sports-league-game");
    betNodes.forEach((betNode) => {
      var gameId = betNode.getAttribute("idgame");

      if (gameId != null) {
        var betCols = betNode.childNodes[0].childNodes;

        // col 0 is time, col 1 is names, col 2 is moneyline odds
        var namesCol = betCols[1];
        var oddsCol = betCols[2];

        var matchInfo: MatchInfo = {
          id: gameId,
          odds: {}
        };

        for (var i=0; i<2; i++) {
          var k = <HTMLElement> namesCol.childNodes[0].childNodes[i];
          var v = <HTMLElement> oddsCol.childNodes[0].childNodes[i];

          matchInfo.odds[k.innerText] = conv_odds(parseInt(v.innerText));
        }

        rets.push(matchInfo);
      }
    });
    return rets
  });

  return matchInfos;
}
