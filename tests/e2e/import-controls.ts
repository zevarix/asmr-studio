import type {Page} from '@playwright/test';

export async function openAudioImport(page:Page):Promise<void> {
  if(!await page.getByLabel('Audio file').isVisible()) {
    await page.getByText('Import your audio',{exact:true}).click();
  }
}
