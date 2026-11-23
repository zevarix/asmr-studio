import {describe,it,expect,vi} from 'vitest';
import {AssistantClient,readConfiguration,ControlError} from './client.js';

const token='a'.repeat(64);
describe('local assistant configuration',()=>{
  it('requires a paired control credential without echoing it',()=>{
    expect(()=>readConfiguration({})).toThrow('ASMR_CONTROL_TOKEN');
    expect(()=>readConfiguration({ASMR_CONTROL_TOKEN:'private input'})).toThrow('ASMR_CONTROL_TOKEN');
    expect(readConfiguration({ASMR_CONTROL_TOKEN:token})).toEqual({origin:'http://127.0.0.1:4318',token});
  });
  it.each(['https://127.0.0.1:4318','http://example.com','http://127.0.0.1.example.com',
    'http://user:password@127.0.0.1:4318','http://127.0.0.1:4318/api','http://127.0.0.1:4318/?token=private',
    'http://127.0.0.1:4318/#private'])('rejects an unsuitable studio URL: %s',url=>{
    expect(()=>readConfiguration({ASMR_CONTROL_TOKEN:token,ASMR_STUDIO_URL:url})).toThrow('loopback');
  });
});
describe('paired API client',()=>{
  it('uses the selected local origin, the control credential, and no redirects',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('[]',{status:200}));
    const client=new AssistantClient({origin:'http://127.0.0.1:4318',token},fetcher);
    await expect(client.devices()).resolves.toEqual([]);
    const [url,options]=fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4318/api/assistant/devices');
    expect(options?.redirect).toBe('error');
    expect(new Headers(options?.headers).get('x-asmr-control-token')).toBe(token);
    expect(new Headers(options?.headers).get('origin')).toBe('http://127.0.0.1:4318');
  });
  it('does not repeat a mutation after an uncertain network result',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error('private network details'));
    const client=new AssistantClient({origin:'http://127.0.0.1:4318',token},fetcher);
    const request={deviceId:'device-a',epoch:'epoch-a',requestId:'request-a',expectedStateVersion:3,action:{type:'play' as const}};
    await expect(client.submit(request)).rejects.toMatchObject({code:'OUTCOME_UNCONFIRMED'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not fetch a library after pairing has been revoked',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({code:'DEVICE_NOT_FOUND',message:'Connection unavailable'}),{status:404}));
    const client=new AssistantClient({origin:'http://127.0.0.1:4318',token},fetcher);
    await expect(client.assets('device-a','epoch-a')).rejects.toBeInstanceOf(ControlError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('validates responses instead of turning malformed state into success',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response('{"connected":true}',{status:200}));
    const client=new AssistantClient({origin:'http://127.0.0.1:4318',token},fetcher);
    await expect(client.device('device-a','epoch-a')).rejects.toThrow();
  });
});
