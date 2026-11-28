import { describe, expect, it } from 'vitest';
import { readNextStepCard, trimNextStepActions } from '../../src/next-step.js';
const card = { kind: 'wrap_up', schema_version: 1, recap: '完成修改；尚未验证。', turn_id: 'turn', ask: '继续吗？', actions: [{kind:'reply',label:'继续'},{kind:'reply',label:'稍后'}], blocked:true,waiting_for_user:true };
describe('persisted next-step contract', () => {
 it('recovers the same card from live and serialized tool results', () => {
 expect(readNextStepCard({details:card})).toEqual(card);
 expect(readNextStepCard(JSON.stringify({details:card}))).toEqual(card);
 });
 it.each([ {kind:'other'}, {schema_version:2}, {suppressed:true}, {recap:' '.repeat(2)}, {recap:'字'.repeat(151)}, {ask:'字'.repeat(201)}, {waiting_for_user:false}, {actions:Array(5).fill(card.actions[0])}])('rejects malformed or unsupported persisted data: %j', patch => {
 expect(readNextStepCard({details:{...card,...patch}})).toBeUndefined();
 });
 it('shows a question longer than the 50 characters the model is asked for, up to 200', () => {
 expect(readNextStepCard({details:{...card,ask:'字'.repeat(200)}})?.ask).toHaveLength(200);
 });
 it('keeps recap-only results valid, but never blocked without a question', () => {
 const recapOnly = {...card,ask:undefined,actions:undefined,blocked:false,waiting_for_user:false};
 expect(readNextStepCard({details:recapOnly})).toEqual(recapOnly);
 expect(readNextStepCard({details:{...recapOnly,blocked:true,waiting_for_user:true}})).toBeUndefined();
 });
 // The question usually lives only in the card, so dropping it would hide it from the user.
 it('removes only the unavailable App actions and keeps the question', () => {
 expect(trimNextStepActions({ask:'提交吗？',actions:[{kind:'app_action',action:'commit'}, {kind:'reply',label:'稍后'}],blocked:true}, [])).toEqual({ask:'提交吗？',actions:[{kind:'reply',label:'稍后'}],blocked:true});
 expect(trimNextStepActions({ask:'继续吗？', actions:[{kind:'reply',label:'继续'}, {kind:'app_action',action:'archive_session'}]}, ['archive_session'])).toEqual({ask:'继续吗？', actions:[{kind:'reply',label:'继续'}, {kind:'app_action',action:'archive_session'}]});
 });
 it('keeps a question whose every answer was an unavailable App action, answered in the composer', () => {
 expect(trimNextStepActions({ask:'提交吗？',actions:[{kind:'app_action',action:'commit'}]}, [])).toEqual({ask:'提交吗？',actions:undefined});
 });
});

describe('cards without a recap', () => {
 const base = { kind: 'wrap_up', schema_version: 1, turn_id: 'turn', blocked: false, waiting_for_user: false } as const;
 it('reads a question whose recap was too long to show', () => {
  const question = { ...base, ask: '现在提交吗？', actions: [{ kind: 'reply' as const, label: '先别提交' }] };
  expect(readNextStepCard({ details: question })).toEqual(question);
 });
 it('rejects a card with neither a recap nor a question', () => {
  expect(readNextStepCard({ details: base })).toBeUndefined();
 });
});

describe('compact decision history', () => {
 it.each([
  {actions: undefined, items: [{id:'mobile',title:'手机适配',suggestion:'调整导航'}, {id:'tests',title:'补充测试',suggestion:'覆盖失败场景'}]},
  {ask: undefined, actions: undefined, questions: [
   {ask:'手机布局选哪种？',actions:[{kind:'reply',label:'底部导航'},{kind:'reply',label:'侧边菜单'}]},
   {ask:'报告用哪种语言？',actions:[{kind:'reply',label:'中文报告'},{kind:'reply',label:'英文报告'}]},
  ]},
 ])('preserves only recap from legacy decisions: %j', patch => {
  const result = readNextStepCard(JSON.stringify({details:{...card,...patch}}));
  expect(result).toEqual({kind:'wrap_up',schema_version:1,recap:card.recap,turn_id:'turn',blocked:false,waiting_for_user:false});
 });
 it('recovers a single answer from live and serialized results and keeps it available', () => {
  const single = {...card,actions:[{kind:'reply' as const,label:'继续'}]};
  expect(readNextStepCard({details:single})).toEqual(single);
  expect(readNextStepCard(JSON.stringify({details:single}))).toEqual(single);
  expect(trimNextStepActions(single,[])).toEqual(single);
  expect(trimNextStepActions({...single,actions:[{kind:'app_action',action:'commit'}]},[]).ask).toBe(single.ask);
 });
 it('reads older reply actions that carried a message, and returns labels only', () => {
  const legacy = [{kind:'reply',label:'按建议来',message:'请适配手机导航并补齐报名校验测试。',recommended:true}, {kind:'reply',label:'暂不继续',message:''}];
  const result = readNextStepCard(JSON.stringify({details:{...card,actions:legacy}}));
  expect(result?.actions).toEqual([{kind:'reply',label:'按建议来',recommended:true}, {kind:'reply',label:'暂不继续'}]);
  expect(result?.actions?.some(action => 'message' in action)).toBe(false);
 });
 it('keeps only the card fields when the result also carries host markers', () => {
  expect(readNextStepCard({details:{...card,terminates_turn:true}})).toEqual(card);
 });
});

it('accepts multi-select and open input, but rejects invalid modes', () => {
 expect(readNextStepCard({details:{...card,selectionMode:'multiple',allowOther:true}})?.selectionMode).toBe('multiple');
 expect(readNextStepCard({details:{...card,selectionMode:'invalid'}})).toBeUndefined();
 expect(readNextStepCard({details:{...card,selectionMode:'multiple',actions:[{kind:'app_action',action:'commit'}]}})).toBeUndefined();
});

it('does not route App actions into a reply-only selection form',()=>{
 const app={kind:'app_action',action:'commit'};
 for(const patch of [{allowOther:true,actions:[app]},{actions:[app,...card.actions]}])
 expect(readNextStepCard({details:{...card,...patch}})).toBeUndefined();
});

it('drops an action it cannot read and keeps the rest of the card', () => {
 const future={kind:'app_action',action:'future_action'};
 expect(readNextStepCard({details:{...card,actions:[future,card.actions[0]]}})).toMatchObject({ask:card.ask,recap:card.recap,actions:[card.actions[0]]});
 expect(readNextStepCard({details:{...card,actions:[future]}})).toMatchObject({ask:card.ask,recap:card.recap,actions:[]});
 expect(readNextStepCard({details:{...card,actions:[{kind:'app_action',action:'execute_shell'},{kind:'reply',label:'续'}]}})?.actions).toEqual([]);
});

it('recovers explicit recommendation metadata without inferring it from position', () => {
 const actions=[{kind:'reply',label:'局部调整',recommended:true},{kind:'reply',label:'整体改造'}];
 expect(readNextStepCard(JSON.stringify({details:{...card,actions}}))?.actions).toEqual(actions);
 expect(readNextStepCard({details:card})?.actions).toEqual(card.actions);
 expect(readNextStepCard({details:{...card,actions:[{...actions[0],recommended:'yes'}]}})?.actions).toEqual([]);
});
