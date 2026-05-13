// members-data.jsx
// Members page utilities + filter list. The MEMBERS array is populated at
// runtime by /members-bridge.js after fetching from the operator API.
// window.MEMBERS starts empty; bridge sets it and fires 'membersLoaded'.

window.MEMBERS = window.MEMBERS || [];

const FILTERS = [
  { id: "all",       label: "All" },
  { id: "holder",    label: "Plan Holders" },
  { id: "sub",       label: "Sub-members" },
  { id: "suspended", label: "Needs attention" },
];

function memberInitials(m) {
  return ((m.first?.[0] || "") + (m.last?.[0] || "")).toUpperCase();
}

function memberFullName(m) { return `${m.first} ${m.last}`; }

window.FILTERS = FILTERS;
window.memberInitials = memberInitials;
window.memberFullName = memberFullName;