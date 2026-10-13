import {MaterialResultExport, RESULT_EXPORT_PREPARE, RESULT_EXPORT_READ_CHUNK} from './collaboration/material-result-export';
import {resultFileCapabilities} from './collaboration/result-file-capabilities';
import {ControlRuntimeSettings} from './setup/control-runtime-settings';
import {ReadSourceSettings} from './setup/read-source-settings';
import type {SetupRuntime} from './setup/service';
import type {captureProtectedReadSource} from './collaboration/read-source';
import {SetupShellStatus} from './setup/shell-status';
import { mkdirSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve,join } from "node:path";
import {GatewayClient,DeviceKey} from 'ash-gateway/client/client';
import {MaterialReceiverCoordinator} from './collaboration/material-receiver-provider';
import {LocalStateTransaction} from './collaboration/local-state-transaction';
import {MaterialInputReader} from './collaboration/material-input-reader';
import {MaterialInputStaging} from './collaboration/material-input-staging';
import {ConnectionSetupService} from './setup/service';
import {SetupError} from './setup/scope-settings';
import {MaterialSetupIpcServer} from './setup/material-ipc';
import {SetupNativeVerification} from './setup/native-verification';
import {captureControlTarget} from './collaboration/control-runtime';
import {MaterialProtocolError} from './collaboration/material-types';
import { currentSetupConnectionProof, ClientLink, fileSigner } from "./link";
import { Workspace, WORKSPACE_CAPABILITIES } from "./workspace";
import { AgentHost } from "./agents/host";
import { detectRuntimes } from "./agents/detect";
import { deviceCli } from "./cli";
import { DEVICE_VERSION, installRelease } from "./install";
import { Browser, detectEgo, EGO_CAPABILITY } from "./browser";
import { KimiBridge, KIMI_CAPABILITIES } from "./kimi";
import { runtimeCatalog } from "./agents/catalog";
import { CollaborationReadService, type ReadServiceOptions } from "./collaboration/read-service";
import { COLLABORATION_LIST,COLLABORATION_READ, isCollaborationCapability, controlOperation, controlCapabilities, createOperation, createCapabilities } from "./collaboration/capabilities";
import { createDeviceControlRuntime, type DeviceControlRuntimeOptions } from "./collaboration/control-runtime";
import { createDeviceCreateRuntime, type DeviceCreateRuntimeOptions } from "./collaboration/create-runtime";
import { CollaborationCreateError } from "./collaboration/create-types";
import { CREATE_INPUT_MAX_BYTES, CREATE_OUTPUT_MAX_BYTES } from "./collaboration/create-protocol";
import { currentPinnedOwnerId } from "./collaboration/pairing";
import { CollaborationControlError } from "./collaboration/control-types";
import { CONTROL_INPUT_MAX_BYTES, CONTROL_OUTPUT_MAX_BYTES } from "./collaboration/control-protocol";
import type { TrustedCallContext } from "./collaboration/authorization";
import type { CallResult } from "../../sdk/src/api";

async function closeAll(resources: (() => unknown | Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(resources.map(close => Promise.resolve().then(close)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** The same fixed collaboration dispatch used by the production device entry. */
export function createDeviceCollaboration(stateDir: string, nodeId: string, dependencies: { readFactory?: ReadServiceOptions["factory"]; controlTesting?: DeviceControlRuntimeOptions["testing"]; controlDeadlineMs?: number; createTesting?: DeviceCreateRuntimeOptions["testing"]; createDeadlineMs?: number;materialInputReader?:MaterialInputReader;testing?:{read?:ReadServiceOptions['testing']} } = {}) {
  const reads = new CollaborationReadService({ stateDir, nodeId, factory: dependencies.readFactory,testing:dependencies.testing?.read });
  const control = createDeviceControlRuntime({ stateDir, nodeId, endpointId: nodeId, pinnedOwnerId: () => currentPinnedOwnerId(stateDir), testing: dependencies.controlTesting, deadlineMs: dependencies.controlDeadlineMs,materialInputReader:dependencies.materialInputReader });
  const create = createDeviceCreateRuntime({ stateDir, nodeId, endpointId: nodeId, pinnedOwnerId: () => currentPinnedOwnerId(stateDir), testing: dependencies.createTesting, deadlineMs: dependencies.createDeadlineMs });
  const results = new MaterialResultExport({stateDir, nodeId, reads});
  return {
    control,create,results,
    get readBusy(){return reads.busy;},
    manifest: (context?: TrustedCallContext) => { const read = reads.manifest(), manifest = control.manifest(), creation = create.manifest(context); return { collaboration: read.collaboration, collaboration_control: manifest, collaboration_create: creation, capabilities: [...read.capabilities, ...controlCapabilities(manifest, nodeId), ...createCapabilities(creation, nodeId), ...resultFileCapabilities(nodeId, read.collaboration.authorization_state === "ready")] }; },
    call: async (name: string, args: Record<string, unknown>, signal?: AbortSignal, context?: TrustedCallContext): Promise<CallResult> => {
      if (name === RESULT_EXPORT_PREPARE || name === RESULT_EXPORT_READ_CHUNK) {
        if (signal?.aborted || !context?.isCurrent()) return {ok:false,content:[],data:{code:"permission_denied"}};
        if (Buffer.byteLength(JSON.stringify(args)) > 64*1024) return {ok:false,content:[],data:{code:"too_large"}};
        const answer=await results.dispatch(name,args,context);
        if (Buffer.byteLength(JSON.stringify(answer)) > 64*1024) return {ok:false,content:[],data:{code:"too_large"}};
        return !signal?.aborted && context.isCurrent() ? answer : {ok:false,content:[],data:{code:"permission_denied"}};
      }
      const creation = createOperation(name), operation = creation ?? controlOperation(name);
      if (!operation) return reads.call(name, args, signal, context);
      try {
        if (!context?.isCurrent()) throw new CollaborationControlError("permission_denied");
        if (signal?.aborted) throw new CollaborationControlError("offline");
        if (Buffer.byteLength(JSON.stringify(args)) > (creation ? CREATE_INPUT_MAX_BYTES : CONTROL_INPUT_MAX_BYTES)) throw new CollaborationControlError("too_large");
        // Abort suppresses this response; it never forwards a cancellation to the daemon.
        const current: TrustedCallContext = { transportOwnerId: context.transportOwnerId, isCurrent: () => !signal?.aborted && context.isCurrent() };
        const data = creation ? await create.execute(creation, args, current) : await control.execute(operation as NonNullable<ReturnType<typeof controlOperation>>, args, current);
        if (!current.isCurrent()) throw new CollaborationControlError("permission_denied");
        if (Buffer.byteLength(JSON.stringify(data)) > (creation ? CREATE_OUTPUT_MAX_BYTES : CONTROL_OUTPUT_MAX_BYTES)) throw new CollaborationControlError("too_large");
        return { ok: true, content: [], data };
      } catch (error) {
        const code = !context?.isCurrent() ? "permission_denied" : error instanceof CollaborationControlError || error instanceof CollaborationCreateError ? error.code : "offline";
        return { ok: false, content: [], error: `Collaboration ${creation ? "create" : "control"}: ${code}`, data: { code } };
      }
    },
    invalidate: () => { results.revoke(); reads.invalidate(); control.invalidate(); create.invalidate(); },
    get busy() { return results.busy || reads.busy || control.busy || create.busy; },
    close: () => closeAll([() => {results.close();}, () => control.close(), () => reads.close(), () => create.close()]),
  };
}

export interface DeviceConfig { gateway: string; name: string; kind?: "laptop" | "server"; stateDir: string; workdir: string; installRoot?: string }
export async function startDevice(config: DeviceConfig, pairCode?: string, dependencies: { agentFactory?: ConstructorParameters<typeof AgentHost>[2]; readFactory?: ReadServiceOptions["factory"]; detect?: typeof detectRuntimes; restart?: () => void; controlTesting?: DeviceControlRuntimeOptions["testing"]; controlDeadlineMs?: number; createTesting?: DeviceCreateRuntimeOptions["testing"]; createDeadlineMs?: number; testing?: {read?:ReadServiceOptions['testing'];readSource?:Parameters<typeof captureProtectedReadSource>[0]['testing'];sourceHome?:string; linkFactory?: (...args: ConstructorParameters<typeof ClientLink>) => ClientLink; kimiFactory?: (stateDir: string) => Pick<KimiBridge, "start" | "url" | "online" | "busy" | "call" | "close">; detectBrowser?: typeof detectEgo; install?: typeof installRelease } } = {}): Promise<{ close(): Promise<void>; run: Promise<void> }> {
  if (!config.gateway || !config.name || !config.stateDir || !config.workdir) throw new Error("gateway, name, stateDir and workdir are required");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); mkdirSync(config.workdir, { recursive: true });
  const signer = await fileSigner(config.stateDir);
  const workspace = new Workspace(resolve(config.workdir), resolve(config.stateDir));
  const agents = new AgentHost(resolve(config.stateDir), resolve(config.workdir), dependencies.agentFactory);
  const runtimes = await runtimeCatalog(config.stateDir, dependencies.detect ?? detectRuntimes);
  const ego = await (dependencies.testing?.detectBrowser ?? detectEgo)(), browser = ego ? new Browser(resolve(config.stateDir), ego) : null;
  const kimi = dependencies.testing?.kimiFactory?.(resolve(config.stateDir)) ?? new KimiBridge(resolve(config.stateDir));
  let updating = false, stopping = false, setupChanging=false;let setupGeneration=0;let setupService:ConnectionSetupService|undefined,setupIpc:MaterialSetupIpcServer|undefined,setupVerification:SetupNativeVerification|undefined,setupSource:ReadSourceSettings|undefined,setupControlRuntime:ControlRuntimeSettings|undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdown: Promise<void> | undefined;
  const materialState=new LocalStateTransaction(resolve(config.stateDir));let receiver:MaterialReceiverCoordinator|undefined;
  const staging=new MaterialInputStaging({rootDir:join(materialState.stateDir,'material-input-cache'),verifyRetirement(){throw new MaterialProtocolError('unsupported');}});
  const reader=new MaterialInputReader({staging,captureInput:(input,proof)=>receiver?receiver.captureInput(input,proof):Promise.reject(new MaterialProtocolError('unsupported'))});
  const collaboration = createDeviceCollaboration(config.stateDir, signer.id, {...dependencies,materialInputReader:reader});
  let link: ClientLink;
  try { link = (dependencies.testing?.linkFactory ?? ((...args: ConstructorParameters<typeof ClientLink>) => new ClientLink(...args)))(config.gateway, signer, {
    manifest: async (context) => { const read = collaboration.manifest(context); return { protocol: "ash-dev/1", version: DEVICE_VERSION, kind: config.kind ?? "laptop", name: config.name, workdir: resolve(config.workdir), collaboration: read.collaboration, collaboration_control: read.collaboration_control, collaboration_create: read.collaboration_create, capabilities: [...WORKSPACE_CAPABILITIES, ...(browser ? [EGO_CAPABILITY] : []), ...(kimi.online ? KIMI_CAPABILITIES : []), ...read.capabilities], agents: runtimes.get() }; },
    call: (name, args, caller, signal, context) => updating || stopping || setupChanging ? Promise.resolve({ ok: false, error: "Device update is in progress", content: [] }) : isCollaborationCapability(name) ? collaboration.call(name, args, signal, context) : name === "browser.script" && browser ? browser.call(args, caller, signal) : name.startsWith("browser.") ? kimi.call(name, args, caller, signal) : workspace.call(name, args, signal),
    collaborationDisconnected: () => collaboration.invalidate(),
    stream: stream => {if(setupChanging||stopping||updating){stream.close();return;}agents.attach(stream);},
    update: async (version, sha256) => {
      if (!config.installRoot || !dependencies.restart) throw new Error("This device was not installed with the service installer");
      if (stopping || updating || setupChanging || agents.busy || workspace.busy || browser?.running || kimi.busy || collaboration.busy || link.materialBusy) throw new Error("Finish or stop active tasks before updating");
      updating = true; agents.accepting = false;
      collaboration.invalidate();
      try { const result = await (dependencies.testing?.install ?? installRelease)(config.installRoot, version, sha256); if (!stopping) restartTimer = setTimeout(dependencies.restart, 1000); return result; }
      catch (error) { updating = false; agents.accepting = true; throw error; }
    },
  }, (...args) => console.error(...args)); }
  catch (error) {
    try{await closeAll([() => collaboration.close(), () => agents.close(), () => workspace.close(), () => kimi.close(), () => runtimes.close()]);}finally{staging.close();materialState.close();}
    throw error;
  }
  const close = () => {
    stopping = true;setupGeneration++; clearTimeout(restartTimer); link.stop(); agents.accepting = false;
    return shutdown ??= closeAll([
      async()=>{if(setupIpc){const result=await setupIpc.close();if(result.state!=='closed')throw Error('Material setup is still draining');}await setupVerification?.close();await setupSource?.close();await setupControlRuntime?.close();setupService?.close();const result=await link.materialWork.drain();if(result.busy)throw new Error("Material I/O is still draining");await collaboration.close();await receiver?.close();staging.close();materialState.close();},
      () => agents.close(), () => workspace.close(), () => kimi.close(), () => runtimes.close(),
    ])
      .catch(error => { shutdown = undefined; throw error; });
  };
  link.materialWork.setAdmissionFence(()=>{if(setupChanging||stopping||updating)throw new SetupError('busy');return undefined;});
  const setupReservation=(readOnly:boolean,materialOnly=false):SetupRuntime=>({reserveChange:async()=>{
    if(setupChanging||stopping||updating)throw new SetupError('busy');
    const connection=readOnly?link.captureReadSetupConnection():undefined;
    setupChanging=true;const generation=++setupGeneration;let released=false;
    const assertCurrent=():undefined=>{
      if(released||stopping||updating||generation!==setupGeneration||!setupChanging)throw new SetupError('stale');
      if(readOnly){if(collaboration.readBusy||setupVerification?.draining)throw new SetupError('busy');if(connection)currentSetupConnectionProof(connection);}
      else{if(agents.busy||workspace.busy||browser?.running||kimi.busy||collaboration.busy||link.materialBusy||receiver?.busy||setupVerification?.draining)throw new SetupError('busy');if(!materialOnly){const control=collaboration.control.changeSafety(),create=collaboration.create.changeSafety();if(control.scope!=='control-runtime'||create.scope!=='create-runtime'||control.state!=='safe'||create.state!=='safe')throw new SetupError(control.state==='busy'||create.state==='busy'?'busy':'unavailable');}}
      return undefined;
    };
    try{assertCurrent();return {assertCurrent,release:():undefined=>{if(!released){released=true;if(!readOnly)receiver?.invalidate();if(generation===setupGeneration&&!stopping&&!updating){setupChanging=false;setupGeneration++;}}return undefined;}};}catch(error){setupChanging=false;setupGeneration++;throw error;}
  }});
  // Receive grants fence local I/O, without changing the native create/control execution binding.
  const setupRuntime=setupReservation(false),readRuntime=setupReservation(true),materialRuntime=setupReservation(false,true);
  setupSource=new ReadSourceSettings({stateDir:materialState.stateDir,endpointId:signer.id,runtime:readRuntime,current:()=>{if(stopping||updating)throw new SetupError('unavailable');return undefined;},...(dependencies.testing?{testing:{defaultHome:dependencies.testing.sourceHome,source:dependencies.testing.readSource}}:{})});
  setupControlRuntime=new ControlRuntimeSettings({stateDir:materialState.stateDir,endpointId:signer.id,runtime:setupRuntime,current:()=>{if(stopping||updating)throw new SetupError('unavailable');return undefined;}});
  setupVerification=new SetupNativeVerification({stateDir:materialState.stateDir,nodeId:signer.id,endpointId:signer.id,current:()=>{if(stopping||updating)throw new SetupError('unavailable');return undefined;},...(dependencies.controlTesting?{testing:dependencies.controlTesting}:{}),...(dependencies.testing?.readSource?{readTesting:dependencies.testing.readSource}:{})});
  setupService=new ConnectionSetupService({verification:setupVerification,shellStatus:new SetupShellStatus({stateDir:materialState.stateDir,verification:setupVerification,connection:()=>link.captureSetupConnection(),current:()=>{if(stopping||updating)throw new SetupError('unavailable');return undefined;}}),stateDir:materialState.stateDir,nodeId:signer.id,endpointId:signer.id,
    materialProjectVerification:async(cwd,ownerId,current)=>{
      const transport=link.materialTransport(),peer=await transport.capture();transport.current(peer);if(peer.peer_id!==ownerId)return false;
      const context:TrustedCallContext={transportOwnerId:ownerId,isCurrent:()=>{try{current();transport.current(peer);return !stopping&&!updating;}catch{return false;}}};
      const manifest=collaboration.create.manifest(context);if(!manifest.authorization_revision)return false;
      const result=await collaboration.create.execute('projects',{version:1,node_id:signer.id,endpoint_id:signer.id,cwd,authorization_revision:manifest.authorization_revision},context);
      current();transport.current(peer);return 'projects' in result&&result.complete===true&&result.projects.some(project=>project.cwd===cwd);
    },
    materialVerification:async grant=>{const transport=link.materialTransport(),peer=await transport.capture();transport.current(peer);if(peer.peer_id!==grant.source_node_id||grant.target.node_id!==signer.id||grant.target.endpoint_id!==signer.id)return false;const revision=collaboration.control.manifest().authorization_revision;if(!revision)return false;const target=await captureControlTarget(collaboration.control,{transportOwnerId:peer.peer_id,isCurrent:()=>{try{transport.current(peer);return !stopping&&!updating;}catch{return false;}}},{work:grant.target,endpoint_id:signer.id,authorization_revision:revision,action:'send_input'},dependencies.controlTesting?'testing':'production');try{transport.current(peer);return await target.check();}finally{target.release();}},
    runtime:setupRuntime,readRuntime,materialRuntime,readSource:setupSource,controlRuntime:setupControlRuntime,
    connectionReady:()=>{try{currentSetupConnectionProof(link.captureSetupConnection());return !stopping&&!updating;}catch{return false;}},
    verifyRead:async(project,current)=>{
      if(realpathSync(project)!==project)throw new SetupError('invalid');
      const connection=link.captureSetupConnection(),owner=currentPinnedOwnerId(materialState.stateDir);if(!owner)throw new SetupError('unpaired');
      const context:TrustedCallContext={transportOwnerId:owner,isCurrent:()=>{try{current();currentSetupConnectionProof(connection);return !stopping&&!updating&&currentPinnedOwnerId(materialState.stateDir)===owner;}catch{return false;}}};
      const manifest=collaboration.manifest(context).collaboration;
      if(manifest.authorization_state!=='ready'||!manifest.authorization_revision)throw new SetupError('unavailable');
      const envelope={version:1,endpoint_id:signer.id,authorization_revision:manifest.authorization_revision,page:{limit:1}};
      const listed=await collaboration.call(COLLABORATION_LIST,envelope,undefined,context);current();if(!listed.ok)throw new SetupError((listed.data as any)?.code==='draining'?'busy':'unavailable');
      const items=(listed.data as any)?.items;if(!Array.isArray(items)||items.some((v:any)=>v.cwd!==project))throw new SetupError('invalid');
      let messages=0;if(items.length){const read=await collaboration.call(COLLABORATION_READ,{...envelope,work:items[0].work},undefined,context);current();if(!read.ok)throw new SetupError('unavailable');messages=((read.data as any)?.items??[]).reduce((n:number,t:any)=>n+(t.messages?.length??0),0);}
      currentSetupConnectionProof(connection);current();return {state:items.length?'readable':'empty',conversations:items.length,messages};
    },
  });
  try{setupIpc=await MaterialSetupIpcServer.open(materialState.stateDir,signer.id,setupService,{pending:()=>collaboration.results.pending(),approve:(id,current)=>collaboration.results.approve(id,current),revoke:()=>collaboration.results.revoke()});}catch(error){await close();throw error;}
  await kimi.start().then(() => console.error('Browser extension endpoint:', kimi.url), () => console.error('Browser extension listener unavailable'));
  try { await link.pair(config.stateDir, pairCode, config.name); }
  catch (error) { await close(); throw error; }
  // Establish real signed material transport without impersonating an unavailable receiver authority.
  receiver=new MaterialReceiverCoordinator({state:materialState,signer,gateway:new GatewayClient(config.gateway,signer as DeviceKey),transport:link.materialTransport(),control:collaboration.control,endpointId:signer.id,observeUnfinished:link.materialWork.observeUnfinished,...(dependencies.controlTesting?{environment:'testing' as const}:{})});
  link.attachMaterialReceiver(receiver);link.createMaterialClient();
  return { run: link.run(), close };
}

if (process.argv[1] && /(?:^|[/\\])(?:main\.ts|ash-device\.mjs)$/.test(process.argv[1])) {
  try { await deviceCli(startDevice); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
