import React from "react";

/** Minimal stroke icon set (currentColor, 1.6 stroke). */
type P = React.SVGProps<SVGSVGElement>;
const S = ({ children, ...rest }: { children: React.ReactNode } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

export const IconProjects = (p: P) => (<S {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></S>);
export const IconAgents = (p: P) => (<S {...p}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.5a3 3 0 0 1 0 5.5" /><path d="M18 20a6 6 0 0 0-3-5.2" /></S>);
export const IconKnowledge = (p: P) => (<S {...p}><path d="M4 5a2 2 0 0 1 2-2h11v16H6a2 2 0 0 0-2 2z" /><path d="M17 3v16" /></S>);
export const IconMcp = (p: P) => (<S {...p}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></S>);
export const IconTools = (p: P) => (<S {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z" /></S>);
export const IconStores = (p: P) => (<S {...p}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></S>);
export const IconRuns = (p: P) => (<S {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></S>);
export const IconAudit = (p: P) => (<S {...p}><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></S>);
export const IconSettings = (p: P) => (<S {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></S>);
export const IconBilling = (p: P) => (<S {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></S>);
export const IconHelp = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" /><path d="M12 17h.01" /></S>);
export const IconPlus = (p: P) => (<S {...p}><path d="M12 5v14M5 12h14" /></S>);
export const IconSearch = (p: P) => (<S {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></S>);
export const IconFilter = (p: P) => (<S {...p}><path d="M3 5h18l-7 8v6l-4-2v-4z" /></S>);
export const IconChevron = (p: P) => (<S {...p}><path d="m6 9 6 6 6-6" /></S>);
export const IconFile = (p: P) => (<S {...p}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></S>);
export const IconMore = (p: P) => (<S {...p}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></S>);
export const IconPin = (p: P) => (<S {...p}><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" /><path d="M12 15v5" /></S>);
export const IconClose = (p: P) => (<S {...p}><path d="M6 6l12 12M18 6 6 18" /></S>);
export const IconShield = (p: P) => (<S {...p}><path d="M12 3 5 6v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5V6z" /><path d="m9 12 2 2 4-4" /></S>);
export const IconCheck = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 4.5-5" /></S>);
export const IconCircle = (p: P) => (<S {...p}><circle cx="12" cy="12" r="8.5" /></S>);
export const IconSend = (p: P) => (<S {...p}><path d="M5 12h13M12 5l7 7-7 7" /></S>);
export const IconBack = (p: P) => (<S {...p}><path d="M15 18l-6-6 6-6" /></S>);
export const IconExternal = (p: P) => (<S {...p}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 14v5H5V5h5" /></S>);
export const IconInbox = (p: P) => (<S {...p}><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></S>);
export const IconAgentFace = (p: P) => (<S {...p}><rect x="4" y="6" width="16" height="12" rx="3" /><path d="M9 11h.01M15 11h.01M12 3v3" /></S>);
export const IconRefresh = (p: P) => (<S {...p}><path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.5 2.5L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.5-2.5L3 16" /><path d="M3 21v-5h5" /></S>);
