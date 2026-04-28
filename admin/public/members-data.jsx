// members-data.jsx
// Members page utilities + filter list. The MEMBERS array is populated at
// runtime by /members-bridge.js after fetching from the operator API.
// window.MEMBERS starts empty; bridge sets it and fires 'membersLoaded'.

window.MEMBERS = window.MEMBERS || [];

const FILTERS = [
  { id: "all",      label: "All" },
  { id: "active",   label: "Active" },
  { id: "holder",   label: "Plan Holders" },
  { id: "suspended",label: "Suspended" },
  { id: "pending",  label: "Pending" },
];

function memberInitials(m) {
  return ((m.first?.[0] || "") + (m.last?.[0] || "")).toUpperCase();
}

function memberFullName(m) { return `${m.first} ${m.last}`; }

window.FILTERS = FILTERS;
window.memberInitials = memberInitials;
window.memberFullName = memberFullName;