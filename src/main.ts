import puppeteer from 'puppeteer';
import express from 'express';

import * as bookmaker from './actions/bookmaker';

const app = express();

(async () => {
  const browser = await puppeteer.launch({
    headless: false
  });
  const page = await browser.newPage();
  await page.setViewport({
    width: 1200,
    height: 800
  })
  console.log(await bookmaker.getBets(page));
  //await page.pdf({path: 'google.pdf'});

  //await browser.close();
})();
//app.get('/', (req, res) =>
  //res.send("halp");
//);

var port: number = 3030;
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
