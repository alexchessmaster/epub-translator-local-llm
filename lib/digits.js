// lib/digits.js — deterministic post-processing of translated output.
//
// The dashboard often runs small local models (e.g. gemma:4b) that garble
// numbers. Instead of trusting the prompt's "use Persian digits" instruction,
// we convert ASCII digits 0-9 → Persian ۰-۹ in code after the model replies.
// Placeholder tokens (⟦s0⟧ ⟦e0⟧ ⟦1⟧ …) must never be touched — their indices
// are digits too — so the token spans are matched and left alone.

const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

function toPersianDigits(text) {
  return String(text).replace(/⟦[^⟧]*⟧|[0-9]/g, (m) =>
    m.length > 1 ? m : PERSIAN[Number(m)],
  );
}

module.exports = { toPersianDigits };
