// Modal explanations (.hint.help) stay hidden until asked for: a HELP toggle
// in each modal head shows the manual text everywhere at once, remembered per
// PC. Live status lines keep the plain .hint class and are never hidden.

import { icon } from './icons.js';

const KEY = 'showHelp';

export function initHelpToggles() {
  const heads = [...document.querySelectorAll('.modal-head')]
    .filter(head => head.closest('.modal').querySelector('.hint.help'));
  if (!heads.length) return;

  const btns = heads.map(head => {
    const b = document.createElement('button');
    b.className = 'helpbtn';
    b.title = 'Show or hide the explanation under each section';
    head.insertBefore(b, head.lastElementChild);
    b.addEventListener('click', () => apply(!document.body.classList.contains('show-help')));
    return b;
  });

  function apply(on) {
    document.body.classList.toggle('show-help', on);
    localStorage.setItem(KEY, on ? '1' : '0');
    for (const b of btns) {
      b.innerHTML = icon('help') + (on ? ' HIDE HELP' : ' HELP');
      b.classList.toggle('on', on);
    }
  }
  apply(localStorage.getItem(KEY) === '1');
}
