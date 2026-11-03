const { launch } = require('puppeteer');
const assert = require('node:assert/strict');
(async()=>{const browser=await launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader'],defaultViewport:{width:1440,height:960}});
try{const page=await browser.newPage();await page.goto('http://127.0.0.1:3190',{waitUntil:'domcontentloaded'});await page.waitForSelector('[data-testid="room-name"]');await new Promise(r=>setTimeout(r,4500));await page.evaluate(()=>{if(document.body.innerText.includes('/omo/demo-project'))[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Yes, I trust the authors')?.click();});
await page._client().send('Emulation.setCPUThrottlingRate',{rate:5});
await page.click('[data-testid="room-name"]');await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.type('Omo Research',{delay:100});await new Promise(r=>setTimeout(r,600));
const value=await page.$eval('[data-testid="room-name"]',el=>el.value);assert.equal(value,'Omo Research','Room name must preserve human typing under rendering load');console.log('PASS: room name survives typing under 5x CPU throttling');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
