// Tiny inline SVG icon set — single-stroke, designed at 16px.

const Icon = ({ name, size = 16, className = "" }) => {
  const s = size, sw = 1.6;
  const common = {
    width: s, height: s, viewBox: "0 0 16 16",
    fill: "none", stroke: "currentColor", strokeWidth: sw,
    strokeLinecap: "round", strokeLinejoin: "round",
    className: `ic ${className}`,
    "aria-hidden": true,
  };
  switch (name) {
    case "search": return (
      <svg {...common}><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>
    );
    case "plus": return (
      <svg {...common}><path d="M8 3v10M3 8h10"/></svg>
    );
    case "download": return (
      <svg {...common}><path d="M8 3v8m0 0 3-3m-3 3-3-3M3 13h10"/></svg>
    );
    case "filter": return (
      <svg {...common}><path d="M2.5 4h11M5 8h6M7 12h2"/></svg>
    );
    case "more": return (
      <svg {...common} strokeWidth="0" fill="currentColor">
        <circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/>
      </svg>
    );
    case "chev-down": return (
      <svg {...common}><path d="m4 6 4 4 4-4"/></svg>
    );
    case "chev-right": return (
      <svg {...common}><path d="m6 4 4 4-4 4"/></svg>
    );
    case "chev-left": return (
      <svg {...common}><path d="m10 4-4 4 4 4"/></svg>
    );
    case "x": return (
      <svg {...common}><path d="m4 4 8 8M12 4l-8 8"/></svg>
    );
    case "users": return (
      <svg {...common}>
        <circle cx="6" cy="6" r="2.4"/><path d="M2 13c.6-2.2 2.1-3.2 4-3.2s3.4 1 4 3.2"/>
        <circle cx="11.5" cy="5.5" r="1.8"/><path d="M14 11.6c-.4-1.4-1.4-2-2.5-2"/>
      </svg>
    );
    case "mail": return (
      <svg {...common}><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/></svg>
    );
    case "edit": return (
      <svg {...common}><path d="M11.5 2.5 13.5 4.5 5 13H3v-2z"/></svg>
    );
    case "ban": return (
      <svg {...common}><circle cx="8" cy="8" r="5.5"/><path d="m4.5 4.5 7 7"/></svg>
    );
    case "alert": return (
      <svg {...common}><path d="M8 2 1.5 13.5h13z"/><path d="M8 6.5v3.5M8 12v.01"/></svg>
    );
    case "trash": return (
      <svg {...common}><path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.7 8.2a1 1 0 0 0 1 .8h2.6a1 1 0 0 0 1-.8L11 4.5"/></svg>
    );
    case "key": return (
      <svg {...common}><circle cx="5.5" cy="9" r="2.5"/><path d="M7.5 7.5 13 2m-2 2 1.5 1.5M9.5 5.5l1.5 1.5"/></svg>
    );
    case "calendar": return (
      <svg {...common}><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/></svg>
    );
    case "credit": return (
      <svg {...common}><rect x="2" y="4" width="12" height="8" rx="1.5"/><path d="M2 7h12M5 10h2"/></svg>
    );
    case "door": return (
      <svg {...common}><path d="M4 2.5h6a1 1 0 0 1 1 1v10H4z"/><path d="M3 13.5h9"/><circle cx="9" cy="8.2" r=".7" fill="currentColor" stroke="none"/></svg>
    );
    case "kbd-cmd": return (
      <svg {...common}><path d="M5.5 5.5h5v5h-5z"/><circle cx="3.5" cy="3.5" r="1.5"/><circle cx="12.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="12.5" r="1.5"/><circle cx="12.5" cy="12.5" r="1.5"/><path d="M5 3.5h-1.5M12.5 5v-1.5M11 3.5h1.5M3.5 5v-1.5M5 12.5h-1.5M12.5 11v1.5M11 12.5h1.5M3.5 11v1.5"/></svg>
    );
    default: return null;
  }
};

window.Icon = Icon;
