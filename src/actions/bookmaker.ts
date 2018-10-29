import fs from 'fs';
import puppeteer from 'puppeteer';

interface PasswordInfo {
  username: string
  password: string
}

const passwords: PasswordInfo = JSON.parse(fs.readFileSync('passwords.json', 'utf8'));

export async function doLogin(page: puppeteer.Page) {
  await page.goto('https://www.bookmaker.eu/');
  await page.type("#account", passwords.username);
  await page.type("#password", passwords.password);
  await page.click("#loginBox > input[type=\"submit\"]");
}

export async function navToBets(page: puppeteer.Page) {
  //bookmaker does two redirects in its login, so just wait for the selector
  //to show up instead of waiting for two loads
  await page.waitForSelector("a[cat=\"TENNIS\"]");

  await page.click("a[cat=\"TENNIS\"]");
 
}


