import {useEffect,useRef,useState} from 'react';
import {CaptureUpdateAction} from '@excalidraw/excalidraw';
import type {ExcalidrawImperativeAPI} from '@excalidraw/excalidraw/types';
import type {ExcalidrawElement} from '@excalidraw/excalidraw/element/types';
import type {BoardController} from './controller';
import {formulaElement} from '../shared/formulas.mjs';
import type {FormulaRender} from '../shared/formulas.mjs';
import './formula-editor.css';

export function FormulaEditor({editor,controller,onClose}:{editor:ExcalidrawImperativeAPI;controller:BoardController;onClose:()=>void}){
  const initial=useRef((()=>{
    const selected=editor.getSceneElements().filter(e=>editor.getAppState().selectedElementIds[e.id]);
    const old=selected.length===1&&selected[0].customData?.formula?selected[0]:null;
    return {old,boardId:controller.getSnapshot().board?.boardId,epoch:controller.getSnapshot().editorEpoch};
  })()).current;
  const meta=initial.old?.customData?.formula as {latex:string;fontSize:number;color:string}|undefined;
  const [latex,setLatex]=useState(meta?.latex??String.raw`p_i=\frac{\exp(z_i/T)}{\sum_{j=1}^{K}\exp(z_j/T)}`);
  const [size,setSize]=useState(meta?.fontSize??30),[color,setColor]=useState(meta?.color??'#35639c');
  const [preview,setPreview]=useState<FormulaRender|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();dialog.current?.querySelector('textarea')?.focus();return()=>dialog.current?.close();},[]);
  useEffect(()=>{
    let active=true;setPreview(null);setLoading(true);setError('');
    const timer=window.setTimeout(()=>{void controller.renderFormula({latex,fontSize:size,color}).then(r=>{if(active)setPreview(r);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});},250);
    return()=>{active=false;clearTimeout(timer);};
  },[latex,size,color,controller]);
  function apply(){
    if(!preview||loading||preview.latex!==latex||preview.fontSize!==size||preview.color!==color)return;
    const state=controller.getSnapshot();
    if(!state.writable||state.bridgeBusy||state.recovery||state.board?.boardId!==initial.boardId||state.editorEpoch!==initial.epoch){setError('白板状态已变化，请关闭后重新打开公式。');return;}
    const elements=editor.getSceneElementsIncludingDeleted();
    const old=initial.old?elements.find(e=>e.id===initial.old!.id):null;
    if(initial.old&&(!old||old.version!==initial.old.version||old.isDeleted)){setError('公式已被修改，请重新打开。');return;}
    try{
      const app=editor.getAppState(),x=-app.scrollX+app.width/app.zoom.value/2-preview.width/2,y=-app.scrollY+app.height/app.zoom.value/2-preview.height/2;
      const element=formulaElement(old??null,preview,crypto.randomUUID(),x,y);
      const next:readonly ExcalidrawElement[]=old?elements.map(e=>e.id===old.id?element:e):[...elements,element];
      editor.addFiles([preview.file]);
      editor.updateScene({elements:next,appState:{selectedElementIds:{[element.id]:true}},captureUpdate:CaptureUpdateAction.IMMEDIATELY});
      onClose();
    }catch(e){setError(e instanceof Error?e.message:'公式保存失败。');}
  }
  return <dialog ref={dialog} role="dialog" className="formula-dialog" onCancel={onClose} aria-labelledby="formula-heading">
    <div className="formula-heading"><h2 id="formula-heading">{initial.old?'编辑公式':'插入公式'}</h2><button onClick={onClose} aria-label="关闭公式编辑器">关闭</button></div>
    <label htmlFor="formula-source">LaTeX</label>
    <textarea id="formula-source" autoFocus spellCheck={false} value={latex} maxLength={2000} onChange={e=>setLatex(e.target.value)} onKeyDown={e=>{if(e.ctrlKey&&e.key==='Enter')apply();}}/>
    <div className="formula-options"><label>字号 <input aria-label="公式字号" type="number" min={16} max={64} value={size} onChange={e=>setSize(Number(e.target.value))}/></label><label>颜色 <input aria-label="公式颜色" type="color" value={color} onChange={e=>setColor(e.target.value)}/></label><span>Fira Math</span></div>
    <div className="formula-preview" aria-label="公式预览" aria-busy={loading}>{preview?<img src={preview.file.dataURL} alt="排版后的公式"/>:loading?<span>排版中…</span>:null}</div>
    {error?<p role="alert">{error}</p>:null}
    <div className="formula-actions"><button onClick={onClose}>取消</button><button className="formula-apply" disabled={!preview||loading} onClick={apply}>{initial.old?'应用修改':'插入白板'}</button></div>
  </dialog>;
}
