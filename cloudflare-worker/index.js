// Cloudflare Worker - 待办提醒定时检查
// 每小时运行一次，检查需要提醒的待办并发送钉钉通知

const SUPABASE_URL = 'https://cbsjlqnfwqtbydubcrpj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNic2pscW5md3F0YnlkdWJjcnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTQ4ODUsImV4cCI6MjA4OTU5MDg4NX0.AZZCotXt-EZP3hl1RoW_PUjWPfcnmdbAvYIxtFN7h2Q';

// 添加 CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Supabase API 调用（带超时）
async function supabaseQuery(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response.json();
  } catch (e) {
    clearTimeout(timeout);
    console.error('查询异常:', e.message);
    return [];
  }
}

// Supabase 更新
async function supabaseUpdate(table, id, data) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return response.ok;
}

// Supabase 插入
async function supabaseInsert(table, data) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return response.ok;
}

// 获取用户 profile（包含钉钉 webhook）
async function getUserProfile(userId) {
  const profiles = await supabaseQuery(`profiles?id=eq.${userId}&select=dingtalk_webhook`);
  if (profiles && profiles.length > 0) {
    return profiles[0];
  }
  return null;
}

// 确保用户有 profile 记录
async function ensureUserProfile(userId) {
  const profiles = await supabaseQuery(`profiles?id=eq.${userId}&select=id`);
  if (!profiles || profiles.length === 0) {
    await supabaseInsert('profiles', { id: userId, dingtalk_webhook: null });
  }
}

// 获取或创建用户 profile
async function getOrCreateProfile(userId) {
  let profiles = await supabaseQuery(`profiles?id=eq.${userId}&select=dingtalk_webhook`);
  if (!profiles || profiles.length === 0) {
    await supabaseInsert('profiles', { id: userId, dingtalk_webhook: null });
    profiles = [{ dingtalk_webhook: null }];
  }
  return profiles[0];
}

// 通过钉钉自定义机器人发送推送
async function sendDingTalkPush(todo, webhook) {
  // 如果用户没有设置 webhook，跳过
  if (!webhook || webhook.trim() === '') {
    console.log(`用户 ${todo.user_id} 未设置钉钉 webhook，跳过推送`);
    return true; // 返回 true 表示已处理（不重试）
  }
  
  // 手动解析本地时间字符串
  const remindParts = todo.remind_at.split(/[- :]/);
  const categoryName = todo.category === 'work' ? '🏢 工作' : todo.category === 'life' ? '🏠 生活' : '📚 学习';
  const priorityLabel = todo.priority === 'urgent' ? '⚡ 紧急' : '○ 普通';
  
  // 格式化提醒时间
  const remindMonth = remindParts[1];
  const remindDay = remindParts[2];
  const remindHour = String(remindParts[3]).padStart(2, '0');
  const remindMin = String(remindParts[4]).padStart(2, '0');
  const dateStr = `${remindMonth}月${remindDay}日 ${remindHour}:${remindMin}`;
  
  // 钉钉 Markdown 格式，标题包含关键字 DoList待办提醒
  const title = 'DoList待办提醒';
  const content = `## 📌 「${todo.text}」\n\n---\n\n📅 **截止日期**：${dateStr}\n\n📋 **分类**：${categoryName}  \n📌 **优先级**：${priorityLabel}`;
  
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title: title,
          text: content
        },
        at: {
          isAtAll: false
        }
      })
    });
    
    const result = await response.json();
    if (result.errcode === 0) {
      console.log(`已推送提醒给用户 ${todo.user_id}: ${todo.id}`);
      return true;
    } else {
      console.error(`推送失败: ${result.errmsg}`);
      return false;
    }
  } catch (e) {
    console.error(`推送异常: ${e.message}`);
    return false;
  }
}

// 主函数
export default {
  async scheduled(event, env, ctx) {
    // 获取当前 UTC 时间
    const nowUtc = new Date();
    // 转换为北京时间 (UTC+8)
    const beijingMs = nowUtc.getTime() + 8 * 60 * 60 * 1000;
    const beijingTime = new Date(beijingMs);
    
    console.log('开始检查待办提醒...');
    console.log('UTC时间:', nowUtc.toISOString());
    console.log('北京时间:', beijingTime.toString());
    
    try {
      // 查询需要提醒的待办（包含 user_id 用于查找各自的 webhook）
      const year = beijingTime.getFullYear();
      const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
      const day = String(beijingTime.getDate()).padStart(2, '0');
      const hour = String(beijingTime.getHours()).padStart(2, '0');
      const minute = String(beijingTime.getMinutes()).padStart(2, '0');
      const second = String(beijingTime.getSeconds()).padStart(2, '0');
      const nowStr = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
      
      const todos = await supabaseQuery(
        `todos?select=id,text,priority,category,remind_at,notified,completed,user_id&remind_at=lte.${nowStr}&notified=eq.false&completed=eq.false`
      );
      
      console.log('查询到的待办数量:', todos ? todos.length : 0);
      
      if (!todos || todos.length === 0) {
        console.log('没有需要提醒的待办');
        return;
      }
      
      console.log(`找到 ${todos.length} 个待办需要提醒`);
      
      for (const todo of todos) {
        // 获取用户的 profile（包含 webhook）
        const profile = await getOrCreateProfile(todo.user_id);
        const webhook = profile ? profile.dingtalk_webhook : null;
        
        const success = await sendDingTalkPush(todo, webhook);
        if (success) {
          // 标记为已通知
          await supabaseUpdate('todos', todo.id, { notified: true });
        }
      }
      
      console.log('提醒检查完成');
    } catch (e) {
      console.error('检查失败:', e.message);
    }
  },
  
  // HTTP 处理
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    const url = new URL(request.url);
    
    // 获取当前 UTC 时间
    const nowUtc = new Date();
    const beijingMs = nowUtc.getTime() + 8 * 60 * 60 * 1000;
    const beijingTime = new Date(beijingMs);
    
    // 测试 Supabase 连通性
    if (url.pathname === '/test-supabase') {
      try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/todos?select=id,text,remind_at,notified,completed,user_id&remind_at=not.is.null`, {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
          }
        });
        const data = await response.json();
        return new Response(JSON.stringify({ ok: true, status: response.status, data }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }
    
    // 测试端点
    if (url.pathname === '/ping') {
      return new Response(JSON.stringify({ ok: true, time: beijingTime.toString() }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // 手动触发检查
    if (request.method === 'POST' && url.pathname === '/check') {
      await this.scheduled(null, env, null);
      return new Response(JSON.stringify({ success: true, message: '检查完成' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
};
