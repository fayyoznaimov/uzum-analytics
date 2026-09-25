export type PeriodQuery={from?:string;to?:string;days?:string|number;compare?:string|boolean};
export type ResolvedPeriod={from:Date;to:Date;fromDate:string;toDate:string;days:number;compare:boolean;prevFrom:Date;prevTo:Date;prevFromDate:string;prevToDate:string};
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
function tashkentDateString(date=new Date()){
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function atStart(date:string){return new Date(`${date}T00:00:00+05:00`)}
function atEnd(date:string){return new Date(`${date}T23:59:59.999+05:00`)}
function dateString(date:Date){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)}
function addDays(date:string,days:number){const d=atStart(date);d.setUTCDate(d.getUTCDate()+days);return dateString(d)}
export function resolvePeriod(query:PeriodQuery={}):ResolvedPeriod{
 const today=tashkentDateString();
 const fallbackDays=Math.min(366,Math.max(1,Number(query.days)||7));
 let fromDate=DATE_RE.test(String(query.from||''))?String(query.from):addDays(today,-fallbackDays+1);
 let toDate=DATE_RE.test(String(query.to||''))?String(query.to):today;
 if(fromDate>toDate)[fromDate,toDate]=[toDate,fromDate];
 const days=Math.min(731,Math.max(1,Math.round((atStart(toDate).getTime()-atStart(fromDate).getTime())/86400000)+1));
 if(days>731)fromDate=addDays(toDate,-730);
 const compare=query.compare===undefined?true:query.compare===true||query.compare==='1'||String(query.compare).toLowerCase()==='true';
 const prevToDate=addDays(fromDate,-1);
 const prevFromDate=addDays(prevToDate,-days+1);
 return{from:atStart(fromDate),to:atEnd(toDate),fromDate,toDate,days,compare,prevFrom:atStart(prevFromDate),prevTo:atEnd(prevToDate),prevFromDate,prevToDate};
}
export function tashkentKey(date:Date){return dateString(date)}
export function tashkentHour(date:Date){return Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tashkent',hour:'2-digit',hourCycle:'h23'}).format(date))}
