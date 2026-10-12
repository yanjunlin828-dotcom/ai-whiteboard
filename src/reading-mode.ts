import {useCallback,useEffect,useRef,useState} from 'react';
import type {RefObject} from 'react';
import type {AppState,ExcalidrawImperativeAPI} from '@excalidraw/excalidraw/types';

export function useReadingMode(editor:RefObject<ExcalidrawImperativeAPI|null>,editorEpoch:number,editorVisible:boolean) {
  const shell=useRef<HTMLElement|null>(null),enterButton=useRef<HTMLButtonElement|null>(null);
  const exitButton=useRef<HTMLButtonElement|null>(null);
  const wanted=useRef(false),ownedFullscreen=useRef(false);
  const [reading,setReading]=useState(false);
  const viewport=useRef<{x:number;y:number;zoom:number;width:number;height:number}|null>(null);
  const rememberView=()=>{
    const a=editor.current?.getAppState();
    if(a)viewport.current={x:a.width/(2*a.zoom.value)-a.scrollX,y:a.height/(2*a.zoom.value)-a.scrollY,
      zoom:a.zoom.value,width:a.width,height:a.height};
  };
  const exit=useCallback(()=>{
    wanted.current=false;setReading(false);
    if(document.fullscreenElement===shell.current) {
      void document.exitFullscreen().catch(()=>{
        // If the browser still owns fullscreen, keep the reachable exit control.
        if(document.fullscreenElement===shell.current){wanted.current=true;setReading(true);}
      });
    }
  },[]);
  const enter=()=>{
    if(wanted.current||!shell.current)return;
    rememberView();wanted.current=true;setReading(true);
    // Called directly from the user's click to preserve fullscreen activation.
    // Embedded browsers may deny this; the page-sized reading mode still works.
    if(!document.fullscreenElement&&document.fullscreenEnabled&&shell.current.requestFullscreen) {
      void shell.current.requestFullscreen().then(()=>{
        if(!wanted.current&&document.fullscreenElement===shell.current)exit();
      }).catch(()=>{/* Keep the chrome-free page fallback. */});
    }
  };
  useEffect(()=>{
    const changed=()=>{
      if(document.fullscreenElement===shell.current)ownedFullscreen.current=true;
      else if(ownedFullscreen.current){ownedFullscreen.current=false;wanted.current=false;setReading(false);}
    };
    const key=(e:KeyboardEvent)=>{
      if(wanted.current&&e.key==='Escape'){e.preventDefault();e.stopPropagation();exit();}
    };
    document.addEventListener('fullscreenchange',changed);
    window.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('fullscreenchange',changed);window.removeEventListener('keydown',key,true);};
  },[exit]);
  useEffect(()=>{
    if(!editorVisible)return;
    const canvas=shell.current?.querySelector<HTMLElement>('.canvas-wrap');
    if(!canvas)return;
    const wheel=(e:WheelEvent)=>{
      const api=editor.current;
      // Leave tool panels, menus and text inputs to their native scrolling.
      if(!api||!(e.target instanceof HTMLCanvasElement)||e.deltaY===0)return;
      // Capture before the editor's pan handler; never zoom the browser page.
      e.preventDefault();e.stopPropagation();
      const a=api.getAppState(),oldZoom=a.zoom.value;
      const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?a.height:1);
      const zoom=Math.max(.1,Math.min(3,oldZoom*Math.exp(-Math.max(-100,Math.min(100,delta))*.002)));
      if(zoom===oldZoom)return;
      const x=e.clientX-a.offsetLeft,y=e.clientY-a.offsetTop;
      api.updateScene({appState:{zoom:{value:zoom as AppState['zoom']['value']},
        scrollX:a.scrollX+x/zoom-x/oldZoom,scrollY:a.scrollY+y/zoom-y/oldZoom}});
    };
    canvas.addEventListener('wheel',wheel,{passive:false,capture:true});
    return()=>canvas.removeEventListener('wheel',wheel,true);
  // Rebind when a board is mounted after the library or replaced on switch.
  },[editor,editorEpoch,editorVisible]);
  useEffect(()=>{
    if(!viewport.current||!shell.current)return;
    let frame=0,settle=0,restoreTimer:ReturnType<typeof setTimeout>|undefined;
    const resize=()=>{
      cancelAnimationFrame(frame);cancelAnimationFrame(settle);
      frame=requestAnimationFrame(()=>{settle=requestAnimationFrame(()=>{
        const api=editor.current,v=viewport.current;if(!api||!v)return;
        const a=api.getAppState();
        const zoom=reading?Math.max(.1,Math.min(3,v.zoom*Math.min(a.width/v.width,a.height/v.height))):v.zoom;
        api.updateScene({appState:{zoom:{value:zoom as AppState['zoom']['value']},
          scrollX:a.width/(2*zoom)-v.x,scrollY:a.height/(2*zoom)-v.y}});
        if(!reading){clearTimeout(restoreTimer);restoreTimer=setTimeout(()=>observer.disconnect(),300);}
      });});
    };
    const observer=new ResizeObserver(resize);
    observer.observe(shell.current.querySelector('.canvas-wrap')!);resize();
    (reading?exitButton:enterButton).current?.focus({preventScroll:true});
    return()=>{observer.disconnect();clearTimeout(restoreTimer);cancelAnimationFrame(frame);cancelAnimationFrame(settle);};
  },[reading,editor]);
  return {shell,enterButton,exitButton,reading,enter,exit};
}
