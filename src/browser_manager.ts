import puppeteer_extra from 'puppeteer-extra'
import puppeteer from 'puppeteer'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

import { v4 as uuidv4 } from 'uuid';

puppeteer_extra.use(StealthPlugin());

function logPrefixNowString(): string {
  return "[" + (new Date().toUTCString()) + "] ";
}

export class BrowserManager {
  testMode: boolean;
  maxBrowserAge: number;
  browserFetchPromise: Promise<puppeteer.Browser> | null = null;
  currentBrowser: puppeteer.Browser | null = null;
  currentBrowserId: string = "";
  currentBrowserStartMs: number = 0; // time this browser was started

  // keep track of all browsers we've opened
  allBrowsers: { [key:string]: puppeteer.Browser } = {};
  // number of pages left in each browser. When this number hits zero, and the
  // browser is no longer active
  allBrowserLatches: { [key:string]: number } = {};

  constructor(testMode: boolean, maxBrowserAge: number) {
    this.testMode = testMode;
    this.maxBrowserAge = maxBrowserAge;
  }

  async _launchBrowser(): Promise<puppeteer.Browser> {
    this.currentBrowser = await puppeteer_extra.launch({
      headless: !this.testMode,
      // TODO: set this for BetOnline (since it uses anti-puppeteer chromium
      // detection now)
      //executablePath: '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome'
    });
    return this.currentBrowser;
  }

  async getBrowser(): Promise<puppeteer.Browser> {
    // if there's an in-flight browser fetch then just chain to that
    if (this.browserFetchPromise) {
      return await this.browserFetchPromise;
    }

    // if the browser is too old then start fetching a new one
    const browserAge = Date.now() - this.currentBrowserStartMs;
    if (browserAge > this.maxBrowserAge) {
      console.log(logPrefixNowString() + "Browser " + this.currentBrowserId +
        " too old (" + browserAge + "ms), starting new browser");
      let _this = this;
      this.browserFetchPromise = this._launchBrowser()
        .then(function(browser: puppeteer.Browser) {
          // close the last browser if it's no longer used
          _this._closeBrowserIfDone(_this.currentBrowserId);

          // then setup info for the new browser
          const browserId = uuidv4();
          _this.browserFetchPromise = null;
          _this.currentBrowserStartMs = Date.now();
          _this.currentBrowserId = browserId;
          _this.currentBrowser = browser;
          _this.allBrowsers[browserId] = browser;
          _this.allBrowserLatches[browserId] = 0;

          console.log(logPrefixNowString() + "Browser " + browserId + " started");
          return browser;
        });
      return await this.browserFetchPromise;
    // otherwise just return the browser
    } else {
      if (this.currentBrowser)
        return this.currentBrowser;
      throw new Error("Browser is somehow null!");
    }
  }

  _closeBrowserIfDone(browserId: string) {
    // we're only done when latch is zero
    if (this.allBrowserLatches[browserId] == 0) {
      console.log(logPrefixNowString() + "Browser " + browserId + " done, closing");
      // don't need to await this, since nothing depends on it being finished
      // TODO: decide if we want to do this in testmode?
      this.allBrowsers[browserId].close();
      delete this.allBrowsers[browserId];
    }
  }

  async withBrowserPage(f: (page: puppeteer.Page) => void): Promise<void> {
    const browser = await this.getBrowser();
    // capture this. It's guaranteed to correspond to browser above since this
    // will happen in the same tick as browser is assigned
    const browserId = this.currentBrowserId;
    this.allBrowserLatches[browserId] = (this.allBrowserLatches[browserId] || 0) + 1;

    // create the page and give it to the client, and let them finish with it
    const page = await browser.newPage();

    // TODO: if anything in f throws an exception, catch it and take a
    // screenshot
    await f(page);

    // once the client is done with the page, close the page
    if(!this.testMode) page.close();

    // then decrement the latch
    --this.allBrowserLatches[browserId];
    // if this browser is no longer current then close the browser if its
    // latch is zero
    if (browserId != this.currentBrowserId) this._closeBrowserIfDone(browserId);
  }
}
