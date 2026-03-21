// Cloudflare Worker - 待办提醒定时检查
// 每小时运行一次，检查需要提醒的待办并发送钉钉通知

const SUPABASE_URL = 'https://cbsjlqnfwqtbydubcrpj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNic2pscW5md3F0YnlkdWJjcnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTQ4ODUsImV4cCI6MjA4OTU5MDg4NX0.AZZCotXt-EZP3hl1RoW_PUjWPfcnmdbAvYIxtFN7h2Q';

// 钉钉自定义机器人 Webhook
const DINGTALK_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=ba334208c606c506094aa6bb1c214f8f227cc1b72ccee484e5c5369d40ee96d1';

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

// 通过钉钉自定义机器人发送推送
async function sendDingTalkPush(todo) {
  // 手动解析本地时间字符串
  const remindParts = todo.remind_at.split(/[- :]/);
  const remindAt = new Date(remindParts[0], remindParts[1]-1, remindParts[2], remindParts[3], remindParts[4], remindParts[5] || 0);
  
  // 计算剩余时间（用北京时间比较）
  const nowUtc = new Date();
  const nowBeijing = new Date(nowUtc.getTime() + 8 * 60 * 60 * 1000);
  const diffMs = remindAt.getTime() - nowBeijing.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  
  let timeStr = '';
  if (diffHours >= 1) timeStr = `${diffHours}小时${diffMins > 0 ? diffMins + '分钟' : ''}`;
  else if (diffMins > 0) timeStr = `${diffMins}分钟`;
  else timeStr = '即将到期';
  
  const categoryName = todo.category === 'work' ? '🏢 工作' : todo.category === 'life' ? '🏠 生活' : '📚 学习';
  const priorityLabel = todo.priority === 'urgent' ? '⚡ 紧急' : '○ 普通';
  
  // 钉钉 Markdown 格式，标题包含关键字 DoList待办提醒
  const title = 'DoList待办提醒';
  const content = `## 📌 「${todo.text}」\n\n---\n\n⏰ **剩余时间**：${timeStr}\n\n📋 **分类**：${categoryName}  \n📌 **优先级**：${priorityLabel}\n\n---\n\n👉 [点击立即处理](https://woyougtr.github.io/DoList/)`;
  
  try {
    const response = await fetch(DINGTALK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title: title,
          text: content
        },
        at: {
          isAtAll: true
        }
      })
    });
    
    const result = await response.json();
    if (result.errcode === 0) {
      console.log(`已推送提醒: ${todo.id}`);
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
      // 查询需要提醒的待办（已到期的提醒时间，已设置提醒且未通知）
      // remind_at 存的是本地时间格式 "2026-03-21 17:30:00"
      // 需要把北京时间转成本地时间格式来比较
      const year = beijingTime.getFullYear();
      const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
      const day = String(beijingTime.getDate()).padStart(2, '0');
      const hour = String(beijingTime.getHours()).padStart(2, '0');
      const minute = String(beijingTime.getMinutes()).padStart(2, '0');
      const second = String(beijingTime.getSeconds()).padStart(2, '0');
      const nowStr = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
      
      const todos = await supabaseQuery(
        `todos?select=id,text,priority,category,remind_at,notified,completed&remind_at=lte.${nowStr}&notified=eq.false&completed=eq.false`
      );
      
      console.log('查询到的待办数量:', todos ? todos.length : 0);
      console.log('查询到的待办:', JSON.stringify(todos));
      
      if (!todos || todos.length === 0) {
        console.log('没有需要提醒的待办');
        return;
      }
      
      console.log(`找到 ${todos.length} 个待办需要提醒`);
      
      for (const todo of todos) {
        const success = await sendDingTalkPush(todo);
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
  
  // HTTP 处理（用于手动触发测试）
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    const url = new URL(request.url);
    
    // 测试 Supabase 连通性
    if (url.pathname === '/test-supabase') {
      try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/todos?select=id,text,remind_at,notified,completed&remind_at=not.is.null`, {
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
      return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
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
