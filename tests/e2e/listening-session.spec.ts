import {test,expect,type Page} from '@playwright/test';
import {wavFixture} from '../fixtures/audio.js';
import {openAudioImport} from './import-controls.js';

async function importRecording(page:Page,name:string,role:'ambience'|'texture'|'narration') {
  await openAudioImport(page);
  await page.getByLabel('Audio file').setInputFiles([{
    name:name+'.wav',mimeType:'audio/wav',
    buffer:Buffer.from(wavFixture({frames:48000,channels:2})),
  }]);
  await page.getByRole('combobox',{name:'Sound role'}).selectOption(role);
  await page.getByRole('checkbox',{name:/permission to listen privately/i}).check();
  await page.getByRole('button',{name:'Import audio'}).click();
  await expect(page.getByRole('button',{name:'Add '+name+'.wav as '+role})).toBeVisible();
}

test('a complete independently adjustable mix is imported, played, saved and reopened',async ({page})=>{
  await page.goto('/?scene=listening-main');
  await importRecording(page,'Rain','ambience');
  await importRecording(page,'Brush','texture');
  await importRecording(page,'Whisper','narration');
  await page.getByRole('button',{name:'Add Rain.wav as ambience'}).click();
  await page.getByRole('button',{name:'Add Brush.wav as texture'}).click();
  await page.getByRole('button',{name:'Add Whisper.wav as narration'}).click();
  const mix=page.getByRole('region',{name:'Active mix'});
  const rain=mix.getByRole('group',{name:/Ambience:/});
  const whisper=mix.getByRole('group',{name:/Narration:/});
  await rain.getByRole('slider',{name:'Volume'}).fill('25');
  await whisper.getByRole('slider',{name:'Volume'}).fill('75');
  await page.getByRole('slider',{name:'Master volume'}).fill('40');
  await expect(rain.getByRole('slider',{name:'Volume'})).toHaveValue('25');
  await expect(whisper.getByRole('slider',{name:'Volume'})).toHaveValue('75');
  await page.getByRole('button',{name:'Start listening'}).click();
  await expect(page.getByRole('status').first()).toContainText('Playing');
  await page.getByRole('button',{name:'Pause'}).click();
  await expect(page.getByRole('status').first()).toContainText('Paused');
  await page.getByRole('button',{name:'Start listening'}).click();
  await expect(page.getByRole('status').first()).toContainText('Playing');
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await page.getByRole('button',{name:'Save session'}).click();
  await expect(page.getByText('Saved revision 1')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button',{name:'Remove Rain.wav from mix'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Active mix'}).getByRole('group',{name:/Narration:/}).getByRole('slider',{name:'Volume'})).toHaveValue('75');
  await expect(page.getByRole('region',{name:'Active mix'}).getByRole('group',{name:/Ambience:/}).getByRole('slider',{name:'Volume'})).toHaveValue('25');
  await expect(page.getByRole('slider',{name:'Master volume'})).toHaveValue('40');
  await expect(page.getByRole('status').first()).not.toContainText('Playing');
});

test('a corrupt import is rejected without losing the active local mix',async ({page})=>{
  await page.goto('/?scene=invalid-upload');
  await page.getByRole('slider',{name:'Master volume'}).fill('30');
  const before=await page.getByRole('region',{name:'Sound library'}).getByRole('listitem').count();
  await openAudioImport(page);
  await page.getByLabel('Audio file').setInputFiles([{name:'broken.wav',mimeType:'audio/wav',buffer:Buffer.from('not audio')}]);
  await page.getByRole('checkbox',{name:/permission to listen privately/i}).check();
  await page.getByRole('button',{name:'Import audio'}).click();
  await expect(page.getByRole('alert')).toContainText(/import/i);
  await expect(page.getByRole('slider',{name:'Master volume'})).toHaveValue('30');
  await expect(page.getByRole('region',{name:'Sound library'}).getByRole('listitem')).toHaveCount(before);
  await expect(page.getByRole('button',{name:'Add broken.wav as ambience'})).toHaveCount(0);
});

test('a failed save does not discard unsaved changes',async ({page})=>{
  await page.goto('/?scene=broken-save');
  await page.getByRole('slider',{name:'Master volume'}).fill('32');
  await page.route('**/api/scenes',async route=>{
    if(route.request().method()==='POST') await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button',{name:'Save session'}).click();
  await expect(page.getByText(/Save failed/i)).toBeVisible();
  await expect(page.getByRole('slider',{name:'Master volume'})).toHaveValue('32');
});

test('a saved session with missing library metadata does not silently autoplay and can be recovered',async ({page})=>{
  await page.goto('/?scene=missing-media-metadata');
  await importRecording(page,'MissingMedia','ambience');
  await page.getByRole('button',{name:'Add MissingMedia.wav as ambience'}).click();
  await page.getByRole('slider',{name:'Master volume'}).fill('36');
  await page.getByRole('button',{name:'Save session'}).click();
  await expect(page.getByText('Saved revision 1')).toBeVisible();
  await page.route('**/api/assets',route=>route.fulfill({status:200,json:[]}));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(/Some recordings are missing/i);
  await expect(page.getByRole('button',{name:'Start listening'})).toBeDisabled();
  await expect(page.getByRole('slider',{name:'Master volume'})).toHaveValue('36');
});

test('missing physical audio at playback reports an error without destroying the scene',async ({page})=>{
  await page.goto('/?scene=missing-blob-content');
  await importRecording(page,'Unavailable','ambience');
  await page.getByRole('button',{name:'Add Unavailable.wav as ambience'}).click();
  await page.route('**/api/assets/*/content',route=>route.fulfill({status:410,body:'unavailable'}));
  await page.getByRole('slider',{name:'Master volume'}).fill('42');
  await page.getByRole('button',{name:'Start listening'}).click();
  await expect(page.getByRole('alert')).toContainText(/could not start/i);
  await expect(page.getByRole('slider',{name:'Master volume'})).toHaveValue('42');
});
