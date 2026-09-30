/* QUESTiX Robot Manager: what the 管理設定 card 「ネットワーク / QUESTiX Local」 says.
   Pure functions of GET /api/wifi-ap (and its `job`), no DOM, exported for the node tests like
   status-view.js. The limits repeat robot_manager/network_admin.py (the root helper checks
   them again; tests/network_view.test.cjs keeps them identical). */
const NetworkView = (() => {
  const BAND = { bg: '2.4 GHz', a: '5 GHz' };
  const CHANNELS = { bg: [1, 6, 11], a: [36, 40, 44, 48] };
  const SSID_PATTERN = '^[A-Za-z0-9_.-][A-Za-z0-9 _.-]{0,30}[A-Za-z0-9_.-]$';
  const PASSWORD_PATTERN = '^[!-\\[\\]-~]{8,63}$';
  const MASK = '••••••••';

  const UPSTREAM = {
    none: 'なし（生徒の端末はロボットにだけつながります）',
    wired: '有線LANあり（外への経路はありません）',
    default_route: 'あり（ロボットの有線LANなどを通って、生徒の端末も外のネットワークに出られます）',
  };

  function clientsText(ap) {
    if (!ap || !ap.active) return '—';
    return Number.isInteger(ap.clients) ? `${ap.clients} 台` : '不明';
  }

  function upstreamText(upstream) {
    return (upstream && UPSTREAM[upstream.summary]) || '不明';
  }

  function bandText(band) {
    return BAND[band] || '—';
  }

  // The card's headline and which buttons may be pressed now.
  function summary(ap) {
    const job = (ap && ap.job) || { state: 'idle' };
    const busy = job.state === 'running';
    const available = Boolean(ap && ap.admin_available);
    let state;
    let label;
    let text;
    if (!ap) {
      state = 'unknown';
      label = '確認中';
      text = 'ロボットの Wi-Fi の状態を確認しています。';
    } else if (!ap.configured) {
      state = 'unconfigured';
      label = '未設定';
      text = '「開始」を押すと、この機体用の名前（SSID）とパスワードを作って開始します。';
    } else if (ap.active) {
      state = 'running';
      label = '稼働中';
      text = `生徒の端末は Wi-Fi「${ap.ssid}」につなぎ、教材タブの QR から開けます。`;
    } else {
      state = 'stopped';
      label = '停止中';
      text = ap.state === 'up'
        ? '設定では「開始」ですが、いまは動いていません（Wi-Fi の装置や周囲の状態を確認してください）。'
        : 'ロボットは、保存済みの Wi-Fi（学校の Wi-Fi など）があればそちらにつなぎます。';
    }
    let notice = '';
    let tone = '';
    if (busy) {
      state = 'applying';
      label = '切り替え中…';
      text = '切り替えています。数十秒かかることがあります。この画面はそのままお待ちください。';
    } else if (job.state === 'failed') {
      notice = job.message || '切り替えに失敗しました。';
      tone = 'error';
    } else if (job.state === 'succeeded') {
      notice = [job.message, job.lab_message].filter(Boolean).join(' ');
      tone = 'ok';
    }
    if (!available && ap) {
      notice = 'この機体には、画面から切り替えるための部品がまだありません（sudo scripts/update-robot-manager.sh を実行してください）。';
      tone = 'error';
    }
    const configured = Boolean(ap && ap.configured);
    return {
      state, label, text, notice, tone,
      canStart: available && !busy && !(ap && ap.active),
      canStop: available && !busy && configured && Boolean(ap.active),
      canSave: available && !busy,
      canRegenerate: available && !busy && configured,
    };
  }

  // Facts shown under the headline: [label, value] pairs.
  function facts(ap) {
    if (!ap || !ap.configured) return [];
    return [
      ['SSID（Wi-Fi の名前）', ap.ssid || '—'],
      ['ロボットの IP', ap.address || '—'],
      ['周波数帯', bandText(ap.band)],
      ['チャンネル', ap.channel ? String(ap.channel) : '—'],
      ['接続中の端末', clientsText(ap)],
      ['外へのネットワーク', upstreamText(ap.upstream)],
    ];
  }

  function passwordText(ap, shown) {
    if (!ap || !ap.configured) return '—';
    return shown ? ap.password || '—' : MASK;
  }

  function channelOptions(band) {
    return CHANNELS[band] || CHANNELS.bg;
  }

  // The PUT /api/wifi-ap/config body: only what the teacher changed, or the first error.
  // form: { ssid, password, band, channel: 'auto' | '6', addressMode: 'auto' | 'manual', address }
  function configChanges(form, ap) {
    const current = ap && ap.configured ? ap : {};
    const body = {};
    const ssid = form.ssid || '';
    if (form.ssid !== undefined && ssid !== (current.ssid || '')) {
      if (!new RegExp(SSID_PATTERN).test(ssid) || new TextEncoder().encode(ssid).length > 32) {
        return { error: 'SSID は 2〜32 文字の英数字・空白・_ . - で入力してください（先頭と末尾に空白は使えません）。' };
      }
      body.ssid = ssid;
    }
    if (form.password) {
      if (!new RegExp(PASSWORD_PATTERN).test(form.password)) {
        return { error: 'パスワードは 8〜63 文字の半角英数字・記号で入力してください（空白と \\ は使えません）。' };
      }
      body.password = form.password;
    }
    const band = form.band || current.band || 'bg';
    if (form.band && form.band !== (current.band || 'bg')) body.band = form.band;
    if (form.channel === 'auto') {
      body.channel = 'auto'; // look around again and take the least crowded one
    } else if (form.channel) {
      const channel = Number(form.channel);
      if (!channelOptions(band).includes(channel)) {
        return { error: `${bandText(band)} で選べるチャンネルは ${channelOptions(band).join('・')} です。` };
      }
      if (body.band || String(channel) !== String(current.channel || '')) body.channel = channel;
    }
    if (form.addressMode === 'manual') {
      const address = (form.address || '').trim();
      if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}\/[0-9]{1,2}$/.test(address)) {
        return { error: 'アドレスは 10.42.0.1/24 のように入力してください。' };
      }
      const now = current.address && current.prefix ? `${current.address}/${current.prefix}` : '';
      if (address !== now) body.address = address;
    } else if (form.addressMode === 'auto' && current.address && current.address !== '10.42.0.1') {
      body.address = 'auto';
    }
    if (!Object.keys(body).length) return { error: '変更された項目がありません。' };
    return { body };
  }

  function confirmText(action, ap) {
    const drop = 'ロボットに Wi-Fi 経由でつないでいる端末（SSH を含む）は、いったん切れます。';
    if (action === 'start') {
      return `QUESTiX Local を開始しますか？ ロボットの Wi-Fi は、学校の Wi-Fi などから離れてアクセスポイントになります。${drop}`;
    }
    if (action === 'stop') {
      return `QUESTiX Local を停止しますか？ 生徒の端末の接続は切れ、ロボットは保存済みの Wi-Fi があればそちらにつなぎます。${drop}`;
    }
    if (action === 'regenerate') {
      return `新しいパスワードを作りますか？ 印刷した接続カードは使えなくなります。${ap && ap.active ? drop : ''}`;
    }
    return `設定を保存しますか？ ${ap && ap.active ? `稼働中のため、すぐに反映します。${drop}` : '次に開始したときから使われます。'}`;
  }

  return {
    BAND, CHANNELS, SSID_PATTERN, PASSWORD_PATTERN, MASK, clientsText, upstreamText, bandText,
    summary, facts, passwordText, channelOptions, configChanges, confirmText,
  };
})();
if (typeof module !== 'undefined') module.exports = NetworkView;
