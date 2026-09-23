import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createFixture} from './fixture.mjs';

const reviewedPlan={summary:'Compare public document parsers against the uploaded requirements.',steps:['Read requirements','Research public docs','Verify citations','Write comparison'],public_queries:['public document parser documentation']};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function untilTask(fixture,id,status){
  for(let count=0;count<200;count++){
    const response=await fixture.request(`/general-api/research/${id}`);
    assert.equal(response.status,200);
    if(response.data.task.status===status)return response.data.task;
    assert.ok(!['failed','invalidated'].includes(response.data.task.status),JSON.stringify(response.data.task.error));
    await sleep(10);
  }
  assert.fail(`task did not reach ${status}`);
}
async function researchFixture(t,overrides={}){
  const calls=[],queries=[];
  const provider={configured:true,publicInfo:{baseUrl:'https://model.example',model:'fixture-model'},async complete({role,prompt,signal}){
    calls.push({role,prompt});signal?.throwIfAborted();
    if(role==='planner')return JSON.stringify(reviewedPlan);
    if(role==='writer')return '# Software parser comparison\n\nThe uploaded requirement is text extraction [S1]. Public documentation supports an example implementation [S2].\n\n## Tradeoffs\nVerify coverage on your own documents before selecting a parser.';
    return `Result from ${role}: evaluate sources [S1] and [S2], clearly label uncertainty.`;
  }};
  const search={configured:true,async search({query}){queries.push(query);return [{kind:'web',title:'Public parser documentation',url:'https://docs.example/parser',content:'Public documentation supports extraction of text documents.',locator:{kind:'web',url:'https://docs.example/parser'}}];}};
  const fixture=await createFixture(t,{serverOptions:{provider,search,...overrides}});
  const kb=await fixture.createLibrary('Requirements');const file=await fixture.upload(kb,'# Requirements\nExtract text and preserve sources.');
  await fixture.processDocument(kb,file,'parse');await fixture.processDocument(kb,file,'index');
  const created=await fixture.request('/general-api/research',{method:'POST',body:{objective:'Compare three open-source document parsers',kb_id:kb,file_ids:[file]}});
  assert.equal(created.status,201,JSON.stringify(created.data));
  return {fixture,kb,file,id:created.data.task.id,calls,queries};
}

test('HTTP workbench gates external transfer, runs separate agents, replays events and exports a sourced report',async t=>{
  const {fixture,id,calls,queries}=await researchFixture(t);
  assert.equal(calls.length,0);assert.equal(queries.length,0);
  assert.equal((await fixture.request(`/general-api/research/${id}/plan`,{method:'POST',body:{}})).status,400);
  assert.equal((await fixture.request(`/general-api/research/${id}/plan`,{method:'POST',body:{allow_external:true}})).status,202);
  await untilTask(fixture,id,'awaiting_confirmation');
  assert.deepEqual(calls.map(x=>x.role),['planner']);assert.equal(queries.length,0);
  const plannedEvents=await fetch(`${fixture.base}/general-api/research/${id}/events?after=0`,{headers:{Authorization:`Bearer ${fixture.token}`}});
  assert.match(plannedEvents.headers.get('content-type'),/text\/event-stream/);
  const eventText=await plannedEvents.text();assert.match(eventText,/event: progress/);assert.ok(eventText.endsWith('\n\n'));
  const cursors=[...eventText.matchAll(/^id: (\d+)$/gm)].map(x=>Number(x[1]));assert.ok(cursors.length>0);
  assert.equal((await fixture.request(`/general-api/research/${id}/approve`,{method:'POST',body:{plan:reviewedPlan,allow_external:false}})).status,400);
  const plan={...reviewedPlan,public_queries:['user reviewed query for open source parsers']};
  assert.equal((await fixture.request(`/general-api/research/${id}/approve`,{method:'POST',body:{plan,allow_external:true}})).status,202);
  const complete=await untilTask(fixture,id,'completed');
  assert.equal(complete.agents.filter(x=>x.status==='completed').length,5);assert.equal(complete.calls_used,5);
  assert.deepEqual(new Set(calls.map(x=>x.role)),new Set(['planner','document_researcher','web_researcher','reviewer','writer']));
  assert.deepEqual(queries,plan.public_queries);
  assert.match(complete.sources[0].content,/Extract text/);assert.equal(complete.sources[0].kind,'document');assert.equal(complete.sources[1].kind,'web');
  const replay=await fetch(`${fixture.base}/general-api/research/${id}/events?after=${cursors.at(-1)}`,{headers:{Authorization:`Bearer ${fixture.token}`}});
  const later=await replay.text();const laterIds=[...later.matchAll(/^id: (\d+)$/gm)].map(x=>Number(x[1]));assert.ok(laterIds.every(x=>x>cursors.at(-1)));assert.match(later,/completed/);
  const report=await fetch(`${fixture.base}/general-api/research/${id}/report`,{headers:{Authorization:`Bearer ${fixture.token}`}});assert.equal(report.status,200);assert.match(await report.text(),/\[S1\].*|\[S2\]/);
  await fixture.restart();await fixture.login();assert.equal((await fixture.request(`/general-api/research/${id}`)).data.task.status,'completed');
});

test('deleting a selected document redacts its research report, sources and agent output',async t=>{
  const {fixture,kb,file,id}=await researchFixture(t);
  await fixture.request(`/general-api/research/${id}/plan`,{method:'POST',body:{allow_external:true}});await untilTask(fixture,id,'awaiting_confirmation');
  await fixture.request(`/general-api/research/${id}/approve`,{method:'POST',body:{plan:reviewedPlan,allow_external:true}});await untilTask(fixture,id,'completed');
  assert.equal((await fixture.request(`/general-api/databases/${kb}/documents/${file}`,{method:'DELETE'})).status,200);
  const task=(await fixture.request(`/general-api/research/${id}`)).data.task;assert.equal(task.status,'invalidated');assert.equal(task.report,'');assert.deepEqual(task.sources,[]);assert.ok(task.agents.every(x=>!x.output));
  assert.equal((await fixture.request(`/general-api/research/${id}/report`)).status,409);
});

test('unconfigured research stays an explicit error and anonymous access is denied',async t=>{
  const {fixture,id}=await researchFixture(t,{provider:{configured:false,publicInfo:{}}});
  assert.equal((await fixture.request('/general-api/research',{auth:null})).status,401);
  assert.equal((await fixture.request(`/general-api/research/${id}/plan`,{method:'POST',body:{allow_external:true}})).status,503);
  assert.equal((await fixture.request(`/general-api/research/${id}`)).data.task.status,'draft');
  const status=await fixture.request('/general-api/status',{auth:null});assert.equal(status.data.research.configured,false);
  assert.equal((await fixture.request('/api/v1/runs')).status,404);
});

test('logout revokes delayed JSON and multipart requests before reads or writes',async t=>{
  const {fixture,kb,file,id,calls,queries}=await researchFixture(t);
  const form=new FormData();form.append('file',new Blob(['Synthetic delayed upload after logout.']), 'late-upload.md');
  const encoded=new Request('http://localhost/upload',{method:'POST',body:form});
  const multipart=Buffer.from(await encoded.arrayBuffer());
  const cases=[
    {path:'/general-api/databases',body:{database_name:'Late library',description:''}},
    {path:'/general-api/research',body:{objective:'Late research',kb_id:kb,file_ids:[file]}},
    {path:`/general-api/databases/${kb}/query`,body:{query:'Extract'}},
    {path:`/general-api/databases/${kb}/documents/${file}/parse`,body:{}},
    {path:`/general-api/databases/${kb}/documents/${file}/index`,body:{}},
    {path:`/general-api/research/${id}/plan`,body:{allow_external:true}},
    {path:`/general-api/research/${id}/cancel`,body:{}},
    {path:`/general-api/databases/${kb}/upload`,raw:multipart,type:encoded.headers.get('content-type')},
  ];
  for(const example of cases){
    const token=fixture.token;
    const raw=example.raw || Buffer.from(JSON.stringify(example.body));
    let observedRequest;
    const started=new Promise(resolve=>{observedRequest=req=>{if(req.url===example.path){fixture.server.off('request',observedRequest);resolve();}};fixture.server.on('request',observedRequest);});
    let pending;
    const response=new Promise((resolve,reject)=>{
      pending=http.request(fixture.base+example.path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':example.type || 'application/json','Content-Length':raw.length}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));res.on('error',reject);
      });
      pending.on('error',reject);pending.write(raw.subarray(0,1));
    });
    await started;
    assert.equal((await fixture.request('/general-api/logout',{method:'POST',auth:token,body:{}})).status,200);
    pending.end(raw.subarray(1));
    const result=await response;
    assert.equal(result.status,401,example.path);
    assert.equal(result.body.error.code,'AUTH_REQUIRED');
    await fixture.login();
  }
  assert.equal((await fixture.request('/general-api/databases')).data.databases.length,1);
  assert.equal((await fixture.request('/general-api/research')).data.tasks.length,1);
  assert.equal((await fixture.request(`/general-api/research/${id}`)).data.task.status,'draft');
  assert.equal((await fixture.request(`/general-api/databases/${kb}/documents`)).data.documents.length,1);
  assert.equal((await fixture.request(`/general-api/databases/${kb}/documents/${file}/basic`)).data.meta.status,'indexed');
  assert.equal(calls.length,0);assert.equal(queries.length,0);
});

test('terminal SSE replay drains more than one event page without dropping its newest state',async t=>{
  const {fixture,id}=await researchFixture(t);
  // Each reviewed attempt adds five durable events; over 200 exercises replay pagination.
  for(let attempt=0;attempt<42;attempt++){
    assert.equal((await fixture.request(`/general-api/research/${id}/plan`,{method:'POST',body:{allow_external:true}})).status,202);
    await untilTask(fixture,id,'awaiting_confirmation');
  }
  const response=await fetch(`${fixture.base}/general-api/research/${id}/events?after=0`,{headers:{Authorization:`Bearer ${fixture.token}`}});
  const text=await response.text();
  const events=[...text.matchAll(/^data: (.+)$/gm)].map(match=>JSON.parse(match[1]));
  assert.equal(events.length,211);
  assert.equal(new Set(events.map(event=>event.seq)).size,events.length);
  assert.equal(events.at(-1).attempt,42);assert.equal(events.at(-1).type,'awaiting_confirmation');
  assert.equal(events.filter(event=>event.type==='planning').length,42);
  const replay=await fetch(`${fixture.base}/general-api/research/${id}/events?after=${events[199].seq}`,{headers:{Authorization:`Bearer ${fixture.token}`}});
  const later=[...(await replay.text()).matchAll(/^data: (.+)$/gm)].map(match=>JSON.parse(match[1]));
  assert.deepEqual(later.map(event=>event.seq),events.slice(200).map(event=>event.seq));
});

test('disconnecting SSE keeps research active; reconnect resumes and explicit cancel stops later roles',async t=>{
  let releaseDocument;
  const documentResult=new Promise(resolve=>{releaseDocument=resolve;});
  const calls=[];
  const provider={configured:true,publicInfo:{},async complete(input){
    calls.push(input);
    if(input.role==='planner')return JSON.stringify(reviewedPlan);
    if(input.role==='document_researcher')return documentResult;
    return 'Public findings [S2].';
  }};
  const {fixture,id}=await researchFixture(t,{provider});
  await fixture.request(`/general-api/research/${id}/plan`,{method:'POST',body:{allow_external:true}});
  await untilTask(fixture,id,'awaiting_confirmation');
  await fixture.request(`/general-api/research/${id}/approve`,{method:'POST',body:{plan:reviewedPlan,allow_external:true}});
  await untilTask(fixture,id,'running');
  const first=await fetch(`${fixture.base}/general-api/research/${id}/events`,{headers:{Authorization:`Bearer ${fixture.token}`}});
  const reader=first.body.getReader();
  const chunk=await reader.read();const text=new TextDecoder().decode(chunk.value);
  const cursor=[...text.matchAll(/^id: (\d+)$/gm)].map(match=>Number(match[1])).at(-1);
  assert.ok(cursor>0);await reader.cancel();
  assert.equal((await fixture.request(`/general-api/research/${id}`)).data.task.status,'running');
  const reconnect=fetch(`${fixture.base}/general-api/research/${id}/events`,{headers:{Authorization:`Bearer ${fixture.token}`,'Last-Event-ID':String(cursor)}});
  assert.equal((await fixture.request(`/general-api/research/${id}/cancel`,{method:'POST',body:{}})).status,200);
  const resumed=await (await reconnect).text();
  const later=[...resumed.matchAll(/^data: (.+)$/gm)].map(match=>JSON.parse(match[1]));
  assert.ok(later.every(event=>event.seq>cursor));assert.equal(later.at(-1).type,'cancelled');
  assert.equal(calls.find(call=>call.role==='document_researcher').signal.aborted,true);
  releaseDocument('Late completed findings [S1].');
  await sleep(10);
  assert.equal((await fixture.request(`/general-api/research/${id}`)).data.task.status,'cancelled');
  assert.ok(!calls.some(call=>['reviewer','writer'].includes(call.role)));
});
