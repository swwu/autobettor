import 'source-map-support/register';

import fs from 'fs';

import puppeteer from 'puppeteer';
import express from 'express';
import bodyParser from 'body-parser';

import * as bookmaker from './actions/bookmaker';

const app = express();


(async () => {
  if (!fs.existsSync('bet_screenshots')){
      fs.mkdirSync('bet_screenshots');
  }

  const browser = await puppeteer.launch({
    headless: false
  });

  app.use(bodyParser.urlencoded());

  app.get('/get_bets_and_bankroll', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const page = await browser.newPage();
    await page.setViewport({
      width: 1200,
      height: 800
    });

    var v: bookmaker.BetsAndBankroll = await bookmaker.getBetsAndBankroll(
      page, req.query["kind"]);

    res.send(JSON.stringify(v));
    page.close();
  });

  app.post('/make_bet', async (req, res) => {
    const page = await browser.newPage();
    await page.setViewport({
      width: 1200,
      height: 800
    });

    await bookmaker.makeBet(page, req.body["kind"],
      req.body["bet_uid"], req.body["match_id"],
      req.body["player_key"], req.body["amount"]);

    res.send("");
    page.close();
  });

  var port: number = 3030;
  app.listen(port, () => console.log(`Example app listening on port ${port}!`))
})();

