'use strict';
// Only loaded by the local integration test child; production timings are untouched.
const scale=30,realNow=Date.now.bind(Date),origin=realNow(),start=Date.now();
Date.now=()=>start+(realNow()-origin)*scale;
const timeout=global.setTimeout,interval=global.setInterval;
global.setTimeout=(fn,ms,...args)=>timeout(fn,Math.max(1,Number(ms)/scale),...args);
global.setInterval=(fn,ms,...args)=>interval(fn,Math.max(1,Number(ms)/scale),...args);
