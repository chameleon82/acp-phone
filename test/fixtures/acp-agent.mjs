import {readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const store = process.argv[2];
let turn = 0;
if (store) { try { turn = Number(readFileSync(store, 'utf8')); } catch {} }
let pending;
const send = (value) => process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', ...value})}\n`);
const reply = (id, result) => send({id, result});
createInterface({input: process.stdin}).on('line', (line) => {
    const {id, method, params} = JSON.parse(line);
    if (method === 'initialize') reply(id, {protocolVersion: 1, agentCapabilities: {loadSession: Boolean(store)}});
    if (method === 'session/new') reply(id, {sessionId: 'conversation'});
    if (method === 'session/load') {
        if (params.sessionId !== 'conversation') {
            send({id, error: {code: -32602, message: 'Unknown session'}});
            return;
        }
        send({method: 'session/update', params: {sessionId: params.sessionId, update: {
            sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'Replayed history.'},
        }}});
        reply(id, {});
    }
    if (method === 'session/prompt') {
        turn++;
        if (store) writeFileSync(store, String(turn));
        send({method: 'session/update', params: {sessionId: params.sessionId, update: {
            sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: `Turn ${turn}.`},
        }}});
        if (params.prompt[0].text === 'wait') pending = id;
        else reply(id, {stopReason: 'end_turn'});
    }
    if (method === 'session/cancel' && pending !== undefined) {
        reply(pending, {stopReason: 'cancelled'});
        pending = undefined;
    }
});
