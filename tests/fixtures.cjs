// Representative selectors and cache shapes from the upstream source links in docs/RESEARCH.md.
// This is a controlled fixture, not a recording of a signed-in Telegram account.
function webK() {
  return `<!doctype html><meta charset="UTF-8"><title>Telegram Web K fixture</title>
  <style>body{font:16px sans-serif;margin:20px}.chat{width:600px}.scrollable-y{height:220px;overflow-y:auto}.bubble{min-height:90px;padding:10px;box-sizing:border-box}.hidden{display:none}.bubbles-remover{display:none}</style>
  <aside>@sidebar_intruder</aside>
  <div class="chat active" data-type="discussion">
    <div class="topbar"><div class="chat-info"><span class="peer-title">Комментарии к посту</span></div></div>
    <div class="bubbles"><div class="bubbles-remover"><div class="bubble" data-mid="999" data-peer-id="-100"><div class="message">@removed_user</div></div></div>
    <div class="scrollable-y"><div class="bubbles-inner">
      <div class="bubble" data-mid="1" data-peer-id="-100"><div class="name"><span class="peer-title" data-peer-id="101">Alice</span></div><div class="message">Привет, @Mention_One! <a href="https://t.me/Linked_user/12">канал</a><div class="reply">@quoted_user</div></div></div>
      <div class="bubble forwarded" data-mid="2" data-peer-id="-100"><div class="name"><span class="peer-title" data-peer-id="999">Original forward author</span></div><div class="message">alice@example.org @Mention_One</div></div>
      <div class="bubble" data-mid="3" data-peer-id="-100"><div class="message">no username</div></div>
      <div class="bubble" data-mid="4" data-peer-id="-100"><div class="message">bot message</div></div>
      <div class="bubble" data-mid="5" data-peer-id="-100"><div class="message">channel message</div></div>
      <div class="bubble" data-mid="6" data-peer-id="-100"><div class="message">uncached message author</div></div>
    </div></div></div>
  </div>
  <script>
    window.rootScope = {myId: 777};
    window.appImManager = {chat: {peerId: -100, threadId: 50, type: 'discussion'}};
    window.fixtureUsers = {
      101: {_: 'user', username: 'Alice_user', pFlags: {}},
      102: {_: 'user', usernames: [{username:'Bob_user',pFlags:{active:true}}, {username:'Bob_alias',pFlags:{active:true}}, {username:'Old_alias',pFlags:{active:false}}], pFlags: {}},
      103: {_: 'user', pFlags: {}},
      104: {_: 'user', username:'Helper_bot', pFlags:{bot:true}},
      999: {_: 'user', username:'Wrong_forward_author', pFlags:{}}
    };
    window.fixtureMessages = {
      1: {fromId:101}, 2: {fromId:102, fwdFromId:999}, 3: {fromId:103},
      4: {fromId:104}, 5: {fromId:-200}, 6: {fromId:106}
    };
    window.apiManagerProxy = {
      getPeer(id) { return window.fixtureUsers[id]; },
      getMessageByPeer(peerId, mid) { if (peerId !== -100) throw new Error('wrong peer'); return window.fixtureMessages[mid]; }
    };
    window.appendMessage = (mid, username) => {
      window.fixtureMessages[mid] = {fromId: 2000 + mid};
      window.fixtureUsers[2000 + mid] = {_: 'user', username, pFlags: {}};
      const el = document.createElement('div'); el.className = 'bubble';
      el.dataset.mid = mid; el.dataset.peerId = '-100';
      const body = document.createElement('div'); body.className = 'message'; body.textContent = 'loaded by scroll';
      el.append(body); document.querySelector('.bubbles-inner').append(el);
    };
  </script>`;
}
function webA() {
  return `<!doctype html><meta charset="UTF-8"><style>.MessageList{height:250px;overflow:auto}.Message{height:100px}</style>
  <aside>@sidebar_person</aside><div id="MiddleColumn"><div class="MiddleHeader"><div class="ChatInfo"><span class="title">Web A chat</span></div></div>
  <div class="Transition_slide-active"><div class="MessageList custom-scroll"><div class="Message message-list-item" data-message-id="1"><div class="text-content">@Public_user <a href="https://t.me/Linked_user">ссылка</a><span class="MessageMeta">@meta_person</span></div></div></div></div></div>`;
}
module.exports = { webK, webA };
