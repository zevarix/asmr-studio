/** Generated PCM fixture. No recorded or copyright-controlled media is checked in. */
export function wavFixture(options: { frames?: number; channels?: number; sampleRate?: number } = {}): Uint8Array {
  const {frames = 4800, channels = 2, sampleRate = 48000} = options;
  const dataBytes = frames * channels * 2;
  const bytes = new Uint8Array(44 + dataBytes); const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((char,index) => view.setUint8(at+index,char.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,36+dataBytes,true);text(8,'WAVE');text(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);
  view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*channels*2,true);
  view.setUint16(32,channels*2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,dataBytes,true);
  for (let frame=0;frame<frames;frame++) for(let channel=0;channel<channels;channel++) {
    view.setInt16(44+(frame*channels+channel)*2,channel===0?1200:-600,true);
  }
  return bytes;
}
