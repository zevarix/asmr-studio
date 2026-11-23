import {serveStdio} from '@modelcontextprotocol/server/stdio';
import process from 'node:process';
import {AssistantClient,readConfiguration} from './client.js';
import {createAssistantServer} from './server.js';

try{
  const client=new AssistantClient(readConfiguration(process.env));
  serveStdio(()=>createAssistantServer(client));
}catch{
  // stdout is reserved for MCP. Never print configuration or paired credentials.
  console.error('ASMR Studio MCP could not start. Check the loopback ASMR_STUDIO_URL and ASMR_CONTROL_TOKEN from the enabled browser tab.');
  process.exitCode=1;
}
