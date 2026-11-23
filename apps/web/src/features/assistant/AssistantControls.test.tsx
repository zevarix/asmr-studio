import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {AssistantDeviceState,AssistantRegistration} from '@asmr-studio/contracts';
import {fixtureScene} from '../../../../../tests/fixtures/scene.js';
import {AssistantControls} from './AssistantControls.js';

const state:AssistantDeviceState={scene:fixtureScene(),stateVersion:7,savedRevision:2,dirty:true,playback:{state:'playing',positionSeconds:2,error:null}};
const connection:AssistantRegistration={deviceId:'one',epoch:'connection',browserToken:'b'.repeat(64),controlToken:'c'.repeat(64),heartbeatIntervalMs:1000,commandTimeoutMs:15000};

it('reveals only the controller key in explicit connection settings and removes it on disconnect',()=>{
  const props={connection,connecting:false,message:'',disabled:false,state,onConnect:vi.fn(),onDisconnect:vi.fn()};
  const {rerender,container}=render(<AssistantControls {...props}/>);
  fireEvent.click(screen.getByText('Assistant controls'));
  expect(container.textContent).not.toContain(connection.controlToken);
  expect(container.textContent).not.toContain(connection.browserToken);
  fireEvent.click(screen.getByRole('button',{name:'Connection settings'}));
  expect(screen.getByLabelText('MCP environment settings')).toHaveTextContent(connection.controlToken);
  expect(container.textContent).not.toContain(connection.browserToken);
  expect(screen.getByRole('status')).toHaveTextContent('Saved revision 2. Unsaved changes.');
  fireEvent.click(screen.getByRole('button',{name:'Disconnect assistant'}));
  expect(props.onDisconnect).toHaveBeenCalledOnce();
  rerender(<AssistantControls {...props} connection={null}/>);
  expect(container.textContent).not.toContain(connection.controlToken);
  expect(screen.getByRole('button',{name:'Enable for this browser'})).toBeEnabled();
});
