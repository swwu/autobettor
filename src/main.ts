import puppeteer from 'puppeteer';
import express from 'express';
import bodyParser from 'body-parser';

import * as bookmaker from './actions/bookmaker';

const app = express();


(async () => {
  const browser = await puppeteer.launch({
    headless: false
  });

  app.use(bodyParser.urlencoded());

  app.get('/get_bankroll', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const page = await browser.newPage();
    await page.setViewport({
      width: 1200,
      height: 800
    });

    var v: number = await bookmaker.getBankroll(page);

    res.send(JSON.stringify(v));
    page.close();
  });

  app.get('/get_bets', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const page = await browser.newPage();
    await page.setViewport({
      width: 1200,
      height: 800
    });

    var v: Array<bookmaker.MatchInfo> = await bookmaker.getBets(page);

    res.send(JSON.stringify(v));
    page.close();
  });

  app.post('/make_bet', async (req, res) => {
    const page = await browser.newPage();
    await page.setViewport({
      width: 1200,
      height: 800
    });

    await bookmaker.makeBet(page, req.body.match_id, req.body.player_key, 1);

    page.close();
  });

  var port: number = 3030;
  app.listen(port, () => console.log(`Example app listening on port ${port}!`))
})();

