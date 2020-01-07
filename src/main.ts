import 'source-map-support/register';

import fs from 'fs';

import puppeteer from 'puppeteer';
import express from 'express';
import bodyParser from 'body-parser';

import morgan from 'morgan';
import morganBody from 'morgan-body';

import * as bookmaker from './drivers/bookmaker';
import * as betonline from './drivers/betonline';
import * as shared from './drivers/shared';

import * as browserManager from './browser_manager';

const app = express();

const TEST_MODE = true;

function getProviderDriver(provider: string): shared.BaseBetDriver {
  return (provider == "bookmaker") ? new bookmaker.BookmakerDriver(TEST_MODE) :
    (provider == "betonline") ? new betonline.BetonlineDriver(TEST_MODE) :
    new shared.BaseBetDriver(TEST_MODE); // TODO: err-handle this case correctly
}

let browsers = new browserManager.BrowserManager(TEST_MODE, 30*60*1000);

(async () => {
  if (!fs.existsSync('bet_screenshots')){
      fs.mkdirSync('bet_screenshots');
  }

  app.use(bodyParser.urlencoded({extended: true}));

  // setup the logger
  morganBody(app, {
    dateTimeFormat: 'utc',
    prettify: false
  });

  app.get('/get_bets_and_bankroll', async (req, res, next) => {
    res.setHeader('Content-Type', 'application/json');

    await browsers.withBrowserPage(async function(page: puppeteer.Page) {
      await page.setViewport({
        width: 1200,
        height: 800
      });

      const provider: string = req.query["provider"];

      let driver: shared.BaseBetDriver = getProviderDriver(provider);

      try {
        const v: shared.BetsAndBankroll = await driver
          .getBetsAndBankroll(page, req.query["kind"]);
        res.send(JSON.stringify(v));
      } catch(err) {
        next(err);
      }
    });
  });

  /*
   * Expects a request body with the following fields:
   *
   * kind [str] - a string determining the kind of match. Should be atp|wta
   * bet_type [str] - a string determining the kind of bet. Should be
   * outright|gamespread
   * bet_uid [str] - a unique string identifying the bet, used for logging
   * purposes in order to associate prediction logs with autobettor logs.
   * match_id [str] - a unique string identifying the match to bet. Should
   * correspond to the id field returned by /get_bets_and_bankroll.
   * player_key [str] - a unique string identifying the player to bet for.
   * Should correspond to the player id returned in /get_bets_and_bankroll.
   * amount [number] - the amount of dollars to bet.
   */
  app.post('/make_bet', async (req, res, next) => {
    await browsers.withBrowserPage(async function(page: puppeteer.Page) {
      await page.setViewport({
        width: 1200,
        height: 800
      });

      const provider: string = req.body["provider"];
      let driver: shared.BaseBetDriver = getProviderDriver(provider);
      try {
        const betAmount: number = await driver
          .makeBet(page, req.body["kind"],
            req.body["bet_type"],
            req.body["bet_uid"], req.body["match_id"],
            req.body["player_key"], req.body["amount"]);
        res.send({"betAmount": betAmount});
      } catch(err) {
        next(err);
      }
    });
  });

  let port: number = 3030;
  app.listen(port, () => console.log(`Listening on port ${port}, test_mode is ${TEST_MODE}`))
})();

