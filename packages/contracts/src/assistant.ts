import {z} from 'zod';
import {sceneSchema,parseWith} from './scene.js';
import {sceneCommandSchema} from './commands.js';

const identity=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const version=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const token=z.string().regex(/^[a-f0-9]{64}$/);
const message=z.string().max(1000).nullable();

export const assistantPlaybackSchema=z.strictObject({
  state:z.enum(['idle','loading','ready','playing','paused','interrupted','error','unknown']),
  positionSeconds:z.number().finite().min(0),
  error:message,
  audioContextState:z.enum(['running','suspended','interrupted','closed','unknown']).optional(),
});
const stateSummaryFields={
  stateVersion:version,
  savedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  dirty:z.boolean(),
  playback:assistantPlaybackSchema,
};
export const assistantStateSummarySchema=z.strictObject(stateSummaryFields);
export const assistantDeviceStateSchema=z.strictObject({...stateSummaryFields,scene:sceneSchema});
export const assistantActionSchema=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('edit'),command:sceneCommandSchema}),
  z.strictObject({type:z.literal('play')}),
  z.strictObject({type:z.literal('pause')}),
  z.strictObject({type:z.literal('stop')}),
  z.strictObject({type:z.literal('save')}),
  z.strictObject({type:z.literal('openSavedSession'),sceneId:z.string().min(1).max(512),discardUnsaved:z.boolean().default(false)}),
  z.strictObject({type:z.literal('undo'),requestId:identity}),
]);
export const assistantCommandRequestSchema=z.strictObject({
  deviceId:identity,epoch:identity,requestId:identity,expectedStateVersion:version,action:assistantActionSchema,
});
export const assistantPendingCommandSchema=assistantCommandRequestSchema.extend({expiresAt:timestamp});
export const assistantRegistrationRequestSchema=z.strictObject({
  name:z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/),state:assistantDeviceStateSchema,
});
export const assistantRegistrationSchema=z.strictObject({
  deviceId:identity,epoch:identity,browserToken:token,controlToken:token,
  heartbeatIntervalMs:z.number().int().positive(),commandTimeoutMs:z.number().int().positive(),
});
export const assistantPollRequestSchema=z.strictObject({epoch:identity,state:assistantDeviceStateSchema});
export const assistantPollResponseSchema=z.strictObject({command:assistantPendingCommandSchema.nullable()});
export const assistantAcknowledgementSchema=z.strictObject({
  epoch:identity,requestId:identity,status:z.enum(['applied','rejected','failed']),message,state:assistantDeviceStateSchema,
});
export const assistantRevokeSchema=z.strictObject({epoch:identity});
export const assistantDeviceViewSchema=z.strictObject({
  deviceId:identity,epoch:identity,name:z.string(),connected:z.boolean(),lastSeenAt:timestamp,observedAt:timestamp,state:assistantDeviceStateSchema,
});
export const assistantCommandReceiptSchema=z.strictObject({
  deviceId:identity,epoch:identity,requestId:identity,expectedStateVersion:version,
  status:z.enum(['queued','dispatched','applied','rejected','failed','expired','disconnected','unconfirmed']),
  submittedAt:timestamp,expiresAt:timestamp,completedAt:timestamp.nullable(),message,
  result:assistantStateSummarySchema.nullable(),
});

export type AssistantPlayback=z.output<typeof assistantPlaybackSchema>;
export type AssistantStateSummary=z.output<typeof assistantStateSummarySchema>;
export type AssistantDeviceState=z.output<typeof assistantDeviceStateSchema>;
export type AssistantAction=z.output<typeof assistantActionSchema>;
export type AssistantCommandRequest=z.output<typeof assistantCommandRequestSchema>;
export type AssistantPendingCommand=z.output<typeof assistantPendingCommandSchema>;
export type AssistantRegistrationRequest=z.output<typeof assistantRegistrationRequestSchema>;
export type AssistantRegistration=z.output<typeof assistantRegistrationSchema>;
export type AssistantPollRequest=z.output<typeof assistantPollRequestSchema>;
export type AssistantPollResponse=z.output<typeof assistantPollResponseSchema>;
export type AssistantAcknowledgement=z.output<typeof assistantAcknowledgementSchema>;
export type AssistantDeviceView=z.output<typeof assistantDeviceViewSchema>;
export type AssistantCommandReceipt=z.output<typeof assistantCommandReceiptSchema>;

export const parseAssistantDeviceState=(input:unknown):AssistantDeviceState=>parseWith(assistantDeviceStateSchema,input);
export const parseAssistantRegistrationRequest=(input:unknown):AssistantRegistrationRequest=>parseWith(assistantRegistrationRequestSchema,input);
export const parseAssistantRegistration=(input:unknown):AssistantRegistration=>parseWith(assistantRegistrationSchema,input);
export const parseAssistantCommandRequest=(input:unknown):AssistantCommandRequest=>parseWith(assistantCommandRequestSchema,input);
export const parseAssistantPollRequest=(input:unknown):AssistantPollRequest=>parseWith(assistantPollRequestSchema,input);
export const parseAssistantPollResponse=(input:unknown):AssistantPollResponse=>parseWith(assistantPollResponseSchema,input);
export const parseAssistantAcknowledgement=(input:unknown):AssistantAcknowledgement=>parseWith(assistantAcknowledgementSchema,input);
export const parseAssistantDeviceView=(input:unknown):AssistantDeviceView=>parseWith(assistantDeviceViewSchema,input);
export const parseAssistantCommandReceipt=(input:unknown):AssistantCommandReceipt=>parseWith(assistantCommandReceiptSchema,input);
