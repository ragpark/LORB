export const errorCopy={
 LAUNCH_CONTEXT_INVALID:{title:'This activity could not be opened',detail:'Return to the previous page.',actions:['Return to catalogue']},
 AUTHENTICATION_EXPIRED:{title:'Your session has expired',detail:'Sign in again to continue.',actions:['Sign in']},
 ACCESS_DENIED:{title:'You cannot access this activity',detail:'Return to the catalogue.',actions:['Return to catalogue']},
 OBJECT_NOT_FOUND:{title:'This activity is no longer available',detail:'Return to the catalogue to choose another activity.',actions:['Return to catalogue']},
 OBJECT_NOT_PUBLISHED:{title:'This activity is not available yet',detail:'Return to the catalogue.',actions:['Return to catalogue']},
 PACKAGE_UNAVAILABLE:{title:'The activity could not be loaded',detail:'Try again in a moment.',actions:['Retry','Return to catalogue']},
 STATE_LOAD_FAILED:{title:'Your previous progress could not be loaded',detail:'Try again, or start again.',actions:['Retry','Return to catalogue']},
 STATE_SAVE_FAILED:{title:'Your progress has not been saved',detail:'Keep the activity open and try again.',actions:['Retry']},
 ATTEMPT_CONFLICT:{title:'This activity is already open',detail:'Return to the catalogue or continue where you left off.',actions:['Return to catalogue']},
 SESSION_EXPIRED:{title:'This activity session has ended',detail:'Relaunch from the catalogue.',actions:['Sign in']},
 EVIDENCE_DELIVERY_DELAYED:{title:'Your activity was saved',detail:'Your results may take longer to appear. You can close safely.',actions:['Close','Return to catalogue']},
 UNKNOWN_ERROR:{title:'We could not open this activity',detail:'Quote support code {supportCode} if you need help.',actions:['Return to catalogue']}
} as const;
export type ErrorCode=keyof typeof errorCopy;
export const getErrorCopy=(code:string,correlationId:string)=>{const item=errorCopy[code as ErrorCode]??errorCopy.UNKNOWN_ERROR;return {...item,detail:item.detail.replace('{supportCode}',correlationId.slice(0,8))}};
