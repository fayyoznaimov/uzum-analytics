"use client";
import { ArrowDownRight, ArrowUpRight, Info } from 'lucide-react';
export function MetricCard({label,value,change,tone='violet',hint}:{label:string;value:string;change?:number;tone?:string;hint?:string}){return <div className={`metric ${tone}`}><div className="metric-top"><span>{label}</span>{hint&&<Info size={14}/>}</div><strong>{value}</strong>{change!==undefined&&<small className={change>=0?'up':'down'}>{change>=0?<ArrowUpRight/>:<ArrowDownRight/>}{Math.abs(change).toFixed(1)}% к прошлому периоду</small>}</div>}
export function Status({children,tone='green'}:{children:React.ReactNode;tone?:string}){return <span className={`status ${tone}`}>{children}</span>}
export function Progress({value}:{value:number}){return <div className="progress"><span style={{width:`${Math.max(0,Math.min(100,value))}%`}}/></div>}
export function Empty({text}:{text:string}){return <div className="empty">{text}</div>}
