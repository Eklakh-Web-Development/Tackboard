import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PORT=4123,tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tb-'));
const srv=spawn('node',['server.js'],{env:{...process.env,PORT,DB_PATH:path.join(tmp,'t.db')},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('server start timeout')),3000);srv.stdout.on('data',d=>{if(String(d).includes('listening')){clearTimeout(t);resolve()}})});
const http=async(method,p,body,token)=>{const r=await fetch('http://localhost:'+PORT+p,{method,headers:{'content-type':'application/json',...(token?{'x-auth-token':token}:{})},body:body?JSON.stringify(body):undefined});const d=await r.json();assert.equal(r.ok,true,JSON.stringify(d));return d};
const open=(token,board)=>new Promise((resolve,reject)=>{const c={inbox:[]},s=new WebSocket(`ws://localhost:${PORT}/ws?board=${board}&token=${encodeURIComponent(token)}`);s.on('message',m=>c.inbox.push(JSON.parse(m)));s.on('error',reject);s.on('open',()=>resolve({...c,ws:s}))});
const next=(c,p,ms=2000)=>new Promise((resolve,reject)=>{const t=Date.now(),i=setInterval(()=>{const k=c.inbox.findIndex(p);if(k>=0){clearInterval(i);resolve(c.inbox.splice(k,1)[0])}else if(Date.now()-t>ms){clearInterval(i);reject(new Error('timeout'))}},10)});
try{
 const a=await http('POST','/api/auth',{name:'Alice'}),b=await http('POST','/api/auth',{name:'Bob'});
 const created=await http('POST','/api/boards',{name:'Shared'},a.token),id=created.board.id;
 await http('POST',`/api/boards/${id}/join?key=${encodeURIComponent(created.shareToken)}`,null,b.token);
 const wa=await open(a.token,id),wb=await open(b.token,id);
 await next(wa,m=>m.t==='snapshot');await next(wb,m=>m.t==='snapshot');
 wa.ws.send(JSON.stringify({t:'op',opId:'o1',op:{type:'card.create',id:'c1',col:'todo',title:'Ship it',description:'',pos:1}}));
 assert.equal((await next(wa,m=>m.t==='ack')).v,1);assert.equal((await next(wb,m=>m.t==='op')).op.title,'Ship it');
 wa.ws.send(JSON.stringify({t:'op',opId:'o1',op:{type:'card.create',id:'c1',col:'todo',title:'Ship it',description:'',pos:1}}));assert.equal((await next(wa,m=>m.t==='ack')).v,1);
 wb.ws.send(JSON.stringify({t:'op',opId:'o2',op:{type:'card.update',id:'c1',title:'Updated'}}));await next(wa,m=>m.t==='op');
 const boards=await http('GET','/api/boards',null,b.token);assert.equal(boards[0].id,id);
 const activity=await http('GET',`/api/boards/${id}/activity`,null,a.token);assert.ok(activity.length>=2);
 const share=await http('POST',`/api/boards/${id}/share`,null,a.token);assert.ok(share.shareToken);
 const denied=await fetch('http://localhost:'+PORT+`/api/boards/${id}/share`,{method:'POST',headers:{'content-type':'application/json','x-auth-token':b.token}});assert.equal(denied.status,403);
 console.log('OK: auth, sharing, realtime sync, idempotency, partial update, membership, activity');
}catch(e){console.error('FAIL:',e);process.exitCode=1}finally{srv.kill();fs.rmSync(tmp,{recursive:true,force:true})}
