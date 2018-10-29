import puppeteer from 'puppeteer';
import express from 'express';

const app = express();

app.get('/', (req, res) =>
  (async () => {
    const browser = await puppeteer.launch({
      headless: false
    });
    const page = await browser.newPage();
    await page.goto('https://google.com');
    //await page.pdf({path: 'google.pdf'});

    //await browser.close();
    res.send("halp");
  })()
);

var port: number = 3030;
app.listen(port, () => console.log(`Example app listening on port ${port}!`))
