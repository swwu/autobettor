import puppeteer from 'puppeteer';
import express from 'express';

import * as bookmaker from './actions/bookmaker';

const app = express();


(async () => {
  const browser = await puppeteer.launch({
    headless: false
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

  var port: number = 3030;
  app.listen(port, () => console.log(`Example app listening on port ${port}!`))
})();

