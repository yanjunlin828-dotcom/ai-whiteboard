import {z} from 'zod';
import {boardIdSchema} from './store.mjs';

export const coordinate=z.number().finite().min(-100000).max(100000);
export const elementId=z.string().min(1).max(200);
const alias=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const color=z.string().regex(/^#[0-9a-fA-F]{6}$/);
const text=z.string().trim().min(1).max(500);
const size=z.number().min(16).max(64);
export const regionSchema=z.object({id:alias,title:text,kind:z.enum(['main','detail']),order:z.number().int().min(0).max(1000),parentId:alias.optional(),lessonId:alias}).strict();
const style={color:color.optional(),backgroundColor:z.union([color,z.literal('transparent')]).optional(),strokeWidth:z.number().min(0.5).max(6).optional(),strokeStyle:z.enum(['solid','dashed','dotted']).optional(),roughness:z.number().min(0).max(2).optional()};
const membership={regionId:alias.optional()};
const connection={from:elementId,to:elementId,fromPort:z.enum(['left','right','top','bottom']).optional(),toPort:z.enum(['left','right','top','bottom']).optional(),route:z.enum(['straight','orthogonal']).optional(),via:z.array(z.array(coordinate).length(2)).max(8).optional(),endArrowhead:z.enum(['arrow','none']).optional(),...style,...membership};
export const itemSchema=z.union([
  z.object({id:alias,type:z.enum(['rectangle','ellipse','diamond']),x:coordinate,y:coordinate,width:z.number().min(40).max(20000).default(240),height:z.number().min(40).max(20000).default(120),text:text.optional(),fontSize:size.optional(),padding:z.number().min(5).max(64).optional(),region:regionSchema.optional(),...style,...membership}).strict(),
  z.object({id:alias,type:z.literal('text'),x:coordinate,y:coordinate,text,fontSize:size.default(28),maxWidth:z.number().min(40).max(4000).optional(),...style,...membership}).strict(),
  z.object({id:alias,type:z.literal('arrow'),...connection}).strict(),
]);
const styled=z.object({fontSize:size.optional(),color:color.optional(),backgroundColor:style.backgroundColor,strokeWidth:style.strokeWidth,strokeStyle:style.strokeStyle,roughness:style.roughness}).strict().refine(x=>Object.values(x).some(v=>v!==undefined),'Specify at least one style');
export const editSchema=z.discriminatedUnion('op',[
  z.object({op:z.literal('set_text'),target:elementId,text}).strict(),
  z.object({op:z.literal('move'),target:elementId,dx:coordinate,dy:coordinate}).strict(),
  z.object({op:z.literal('connect'),id:alias,...connection}).strict(),
  z.object({op:z.literal('resize'),target:elementId,width:z.number().min(40).max(20000),height:z.number().min(40).max(20000)}).strict(),
  z.object({op:z.literal('set_style'),target:elementId,style:styled}).strict(),
  z.object({op:z.literal('set_region'),target:elementId,region:regionSchema.optional(),regionId:alias.optional()}).strict(),
  z.object({op:z.literal('move_region'),regionId:alias,dx:coordinate,dy:coordinate}).strict(),
  z.object({op:z.literal('reroute'),target:elementId,fromPort:connection.fromPort,toPort:connection.toPort,route:connection.route,via:connection.via,endArrowhead:connection.endArrowhead}).strict(),
  z.object({op:z.literal('set_formula'),target:elementId,latex:text,fontSize:size.optional(),color:color.optional()}).strict(),
]);
export const patchShape={boardId:boardIdSchema.optional(),editorSessionId:z.string().uuid().optional(),baseRevision:z.number().int().nonnegative(),requestId:z.string().uuid(),
  flow:z.object({title:text,steps:z.array(z.object({id:alias,label:text,description:text.optional()}).strict()).min(2).max(5),note:text.optional()}).strict().optional(),
  items:z.array(itemSchema).min(1).max(40).optional(),edits:z.array(editSchema).min(1).max(40).optional(),selectionIds:z.array(elementId).max(100).optional()};
export const patchSchema=z.object(patchShape).strict().superRefine((input,ctx)=>{
  const issue=message=>ctx.addIssue({code:'custom',message});
  if([input.flow,input.items,input.edits].filter(Boolean).length!==1)issue('Provide exactly one of flow, items or edits.');
  if(input.selectionIds&&(!input.edits||new Set(input.selectionIds).size!==input.selectionIds.length))issue('selectionIds must be unique and used with edits.');
  const items=input.items??input.flow?.steps??[];
  if(new Set(items.map(i=>i.id)).size!==items.length)issue('IDs must be unique.');
  for(const item of input.items??[]){
    if(item.region&&(item.type!=='rectangle'||item.text||item.regionId&&item.regionId!==item.region.id))issue('A region uses an empty rectangle; put its title in a separate text item.');
    if(item.type==='arrow'){
      const nodes=input.items.filter(i=>['rectangle','ellipse','diamond'].includes(i.type));
      if(item.from===item.to||!nodes.some(n=>n.id===item.from)||!nodes.some(n=>n.id===item.to))issue('items arrows connect nodes in this batch; use edits.connect for existing nodes.');
    }
  }
  for(const op of input.edits??[])if(op.op==='set_region'&&Boolean(op.region)===Boolean(op.regionId))issue('set_region needs exactly one of region or regionId.');
});
export const readShape={boardId:boardIdSchema.optional(),editorSessionId:z.string().uuid().optional(),scope:z.enum(['all','selection']).default('all'),limit:z.number().int().min(1).max(500).default(150),offset:z.number().int().min(0).max(2000).default(0),revision:z.number().int().nonnegative().optional(),regionId:alias.optional(),summary:z.boolean().default(false)};
export const renderShape={boardId:boardIdSchema.optional(),editorSessionId:z.string().uuid().optional(),revision:z.number().int().nonnegative(),elementIds:z.array(elementId).max(100).optional(),regionId:alias.optional()};
export const validateShape={boardId:boardIdSchema.optional(),editorSessionId:z.string().uuid().optional(),revision:z.number().int().nonnegative(),regionId:alias.optional(),minFontSize:size.default(24)};
export const previewShape={...patchShape,regionId:alias.optional()};
export const previewSchema=patchSchema.safeExtend({regionId:alias.optional()});
