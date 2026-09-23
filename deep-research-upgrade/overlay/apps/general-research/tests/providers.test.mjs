import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createModelProvider,createWebSearch,modelEndpoint,isPublicAddress,publicUrl,readPublicPage,htmlText} from '../lib/providers.mjs';

test('model adapter calls only the configured endpoint and keeps credentials out of public status',async()=>{
  let recorded;
  const provider=createModelProvider({baseUrl:'https://models.example/v1',model:'configured-model',apiKey:'synthetic-secret',fetchImpl:async(url,options)=>{recorded={url,options,body:JSON.parse(options.body)};return Response.json({choices:[{finish_reason:'stop',message:{content:'Evidence analysis'}}]});}});
  assert.equal(await provider.complete({role:'reviewer',prompt:'Review software notes'}),'Evidence analysis');
  assert.equal(recorded.url,'https://models.example/v1/chat/completions');
  assert.equal(recorded.options.headers.Authorization,'Bearer synthetic-secret');
  assert.equal(recorded.body.model,'configured-model');assert.equal(recorded.body.store,false);
  assert.match(recorded.body.messages[0].content,/untrusted evidence/);
  assert.ok(!JSON.stringify(provider.publicInfo).includes('secret'));
});

test('missing, malformed and incomplete model responses never become successful output',async()=>{
  await assert.rejects(createModelProvider().complete({role:'planner',prompt:'x'}),{code:'MODEL_NOT_CONFIGURED'});
  for(const response of [Response.json({choices:[]}),Response.json({choices:[{finish_reason:'length',message:{content:'partial'}}]}),new Response('secret-error-payload',{status:401})]){
    const provider=createModelProvider({baseUrl:'https://models.example/v1',model:'test',apiKey:'secret',fetchImpl:async()=>response});
    await assert.rejects(provider.complete({role:'planner',prompt:'x'}),error=> !error.message.includes('secret-error-payload') && error.status===502);
  }
  assert.throws(()=>modelEndpoint('http://public.example/v1'));
  assert.throws(()=>modelEndpoint('https://user:pass@public.example/v1'));
  assert.equal(modelEndpoint('http://127.0.0.1:9000/v1'),'http://127.0.0.1:9000/v1/chat/completions');
});

test('model cancellation propagates and streaming response size is bounded',async()=>{
  const controller=new AbortController();controller.abort(new Error('cancelled by user'));
  const cancelled=createModelProvider({baseUrl:'https://models.example/v1',model:'test',apiKey:'secret',fetchImpl:async(_url,options)=>{options.signal.throwIfAborted();}});
  await assert.rejects(cancelled.complete({role:'writer',prompt:'x',signal:controller.signal}),/cancelled by user/);
  const huge=createModelProvider({baseUrl:'https://models.example/v1',model:'test',apiKey:'secret',fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))});
  await assert.rejects(huge.complete({role:'writer',prompt:'x'}),{code:'EXTERNAL_SIZE'});
});

test('public source filtering rejects local/private/transition addresses and unsafe URLs',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.5.4','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) assert.equal(isPublicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','93.184.216.34','198.51.1.1','203.0.114.1','192.0.10.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicAddress(ip),true,ip);
  for(const ip of ['192.0.0.1','192.0.2.1','192.88.99.1','198.18.1.1','198.19.255.255','198.51.100.1','203.0.113.1']) assert.equal(isPublicAddress(ip),false,ip);
  for(const url of ['file:///etc/passwd','http://example.com','https://127.1','https://localhost','https://foo.local','https://user:pass@example.com','https://example.com:8443'])assert.throws(()=>publicUrl(url));
});

test('public reader pins validated DNS and revalidates redirects rather than forwarding headers',async()=>{
  let called=false;
  await assert.rejects(readPublicPage('https://example.com',{lookupImpl:async()=>[{address:'127.0.0.1',family:4}],requestImpl:()=>{called=true;}}),{code:'UNSAFE_SOURCE'});
  assert.equal(called,false);
  const requests=[];
  function requestImpl(url,options,callback){
    const request=new EventEmitter();request.end=()=>{
      requests.push({url:String(url),headers:options.headers});
      options.lookup(url.hostname,{all:true},(_error,addresses)=>assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]));
      const response=Readable.from([Buffer.from('<html><script>secretbad()</script><main>Public manual example.</main></html>')]);
      response.statusCode=200;response.headers={'content-type':'text/html; charset=utf-8'};callback(response);
    };return request;
  }
  const page=await readPublicPage('https://example.com/manual',{lookupImpl:async()=>[{address:'93.184.216.34',family:4}],requestImpl});
  assert.equal(page.content,'Public manual example.');
  assert.equal(page.locator.scope,'page_excerpt');
  assert.ok(!('Authorization' in requests[0].headers));
  const redirectImpl=(_url,_options,callback)=>{const req=new EventEmitter();req.end=()=>{const res=Readable.from([]);res.statusCode=302;res.headers={location:'http://127.0.0.1/admin'};callback(res);};return req;};
  await assert.rejects(readPublicPage('https://example.com',{lookupImpl:async()=>[{address:'93.184.216.34',family:4}],requestImpl:redirectImpl}),{code:'UNSAFE_SOURCE'});
});

test('web search transmits only the reviewed query and promotes fetched page text, not snippets',async()=>{
  const calls=[];
  const search=createWebSearch({apiKey:'synthetic-search-token',fetchImpl:async(url,options)=>{calls.push({url:new URL(url),options});return Response.json({web:{results:[{title:'Manual',url:'https://manual.example/guide',description:'invented snippet'},{title:'Private',url:'https://127.0.0.1/secret'}]}});},pageReader:async(url)=>({url,content:'Actual retrieved documentation.',locator:{kind:'web',url,scope:'page_excerpt'}})});
  const result=await search.search({query:'reviewed public software comparison'});
  assert.equal(calls.length,1);assert.equal(calls[0].url.searchParams.get('q'),'reviewed public software comparison');
  assert.equal(result.length,1);assert.equal(result[0].content,'Actual retrieved documentation.');
  assert.ok(!JSON.stringify(result).includes('invented snippet'));
  await assert.rejects(createWebSearch().search({query:'x'}),{code:'SEARCH_NOT_CONFIGURED'});
});

test('unreadable web pages cannot produce citations from search snippets alone',async()=>{
  const search=createWebSearch({apiKey:'synthetic',fetchImpl:async()=>Response.json({web:{results:[{title:'Lost',url:'https://example.com',description:'not evidence'}]}}),pageReader:async()=>{throw new Error('unavailable');}});
  await assert.rejects(search.search({query:'example'}),{code:'NO_WEB_EVIDENCE'});
  assert.equal(htmlText('<style>bad</style><p>A &amp; B &#x41;</p>'),'A & B A');
});

test('public source DNS wait ends when the task is cancelled',async()=>{
  const controller=new AbortController();
  const request=readPublicPage('https://example.com',{signal:controller.signal,lookupImpl:()=>new Promise(()=>{})});
  controller.abort(new Error('cancel DNS'));
  await assert.rejects(request,/cancel DNS/);
});
