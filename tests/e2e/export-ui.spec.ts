import {randomUUID} from 'node:crypto';
import {test,expect} from '@playwright/test';
import {wavFixture} from '../fixtures/audio.js';
import {fixtureLayer,fixtureScene} from '../fixtures/scene.js';
import {defaultLoop} from '../../apps/web/src/features/mixer/sound-utils.js';

test('a saved WAV export survives page reload while the current mix keeps playing',async({page,baseURL})=>{
  const headers={Origin:baseURL!};
  const uploaded=await page.request.post('/api/assets',{headers:{...headers,'content-type':'audio/wav',
    'x-asmr-metadata':JSON.stringify({displayName:'Export UI texture',roles:['texture'],
      provenance:{kind:'original',source:'Generated browser test PCM'},rights:{privateUse:'permitted',redistribution:'permitted'}})},
    data:Buffer.from(wavFixture({sampleRate:48000,frames:48000,channels:2}))});
  expect(uploaded.status()).toBe(201);
  const asset=await uploaded.json();
  const scene={...fixtureScene(),id:'export-ui-'+randomUUID(),title:'Finished listening test',revision:0,
    // Match real library additions when the device resamples a one-second clip to 44.1 kHz.
    durationSeconds:null,layers:[fixtureLayer({assetId:asset.id,role:'texture',loop:{...defaultLoop(asset.durationSeconds),crossfadeSeconds:.02}})]};
  expect((await page.request.post('/api/scenes',{headers,data:scene})).status()).toBe(201);
  await page.goto('/?scene='+scene.id);
  await page.getByRole('button',{name:'Start listening'}).click();
  await expect(page.getByRole('status').first()).toContainText('Playing');
  await page.getByRole('slider',{name:'Master volume',exact:true}).fill('21');
  await page.getByText('Export mix',{exact:true}).click();
  const panel=page.locator('.export-panel');
  await panel.getByRole('spinbutton',{name:'Duration (minutes)'}).fill('0.02');
  await panel.getByRole('button',{name:'Save & export WAV'}).click();
  const download=panel.getByRole('link',{name:'Download WAV'});
  await expect(download).toBeVisible({timeout:30000});
  await expect(page.getByRole('status').first()).toContainText('Playing');
  const saved=await(await page.request.get('/api/scenes/'+scene.id)).json();
  expect(saved).toMatchObject({revision:2,masterGain:.21});
  const contentUrl=await download.getAttribute('href');
  const response=await page.request.get(contentUrl!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('audio/wav');
  expect((await response.body()).subarray(0,4).toString()).toBe('RIFF');
  const recipeUrl=await panel.getByRole('link',{name:'Recipe & credits'}).getAttribute('href');
  const recipe=await(await page.request.get(recipeUrl!)).json();
  expect(recipe.scene).toMatchObject({id:scene.id,revision:2,masterGain:.21});
  expect(recipe.durationSeconds).toBe(1.2);
  expect(recipe.assets[0]).toMatchObject({id:asset.id,sha256:asset.sha256});

  // Editing and saving a newer live mix must not mutate the finished recipe.
  await page.getByRole('slider',{name:'Master volume',exact:true}).fill('35');
  await page.getByRole('button',{name:'Save session',exact:true}).click();
  await expect(page.getByText('Saved revision 3',{exact:true})).toBeVisible();
  expect((await(await page.request.get(recipeUrl!)).json()).scene.masterGain).toBe(.21);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.reload();
  await page.getByText('Export mix',{exact:true}).click();
  await expect(download).toHaveAttribute('href',contentUrl!);
  await expect(page.getByRole('slider',{name:'Master volume',exact:true})).toHaveValue('35');
  await expect(page.getByRole('status').first()).not.toContainText('Playing');
});
