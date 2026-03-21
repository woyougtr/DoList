// Cloudflare Worker - 待办提醒定时检查
// 每小时运行一次，检查需要提醒的待办并发送 QQ 通知

const SUPABASE_URL = 'https://cbsjlqnfwqtbydubcrpj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNic2pscW5md3F0YnlkdWJjcnBqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTQ4ODUsImV4cCI6MjA4OTU5MDg4NX0.AZZCotXt-EZP3hl1RoW_PUjWPfcnmdbAvYIxtFN7h2Q';

// OpenClaw API 配置
const OPENCLAW_URL = 'http://localhost:18789';  // 本地 OpenClaw 地址
const QQ_OPENID = 'D1F392591BD860B931F5CCD67AA14A19';  // 用户的 QQ OpenID

// 添加 CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Supabase API 调用
async function supabaseQuery(query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    }
  });
  return response.json();
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

// 创建 OpenClaw cron 任务
async function createOpenClawReminder(todo) {
  const remindAt = new Date(todo.remind_at);
  const atMs = remindAt.getTime();
  
  // 计算剩余时间用于消息
  const now = new Date();
  const diffMs = remindAt.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  
  let timeStr = '';
  if (diffHours >= 1) timeStr = `${diffHours}小时${diffMins > 0 ? diffMins + '分钟' : ''}`;
  else timeStr = `${diffMins}分钟`;
  
  const message = `📋 待办提醒：「${todo.text}」${timeStr}后到期！`;
  
  const cronJob = {
    action: 'add',
    job: {
      name: `待办提醒-${todo.id.slice(0, 8)}`,
      schedule: { kind: 'at', atMs: atMs },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      deleteAfterRun: true,
      payload: {
        kind: 'agentTurn',
        message: message,
        deliver: true,
        channel: 'qqbot',
        to: QQ_OPENID
      }
    }
  };
  
  try {
    // 通过 OpenClaw 本地 API 创建 cron
    const response = await fetch(`${OPENCLAW_URL}/api/cron/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cronJob)
    });
    
    if (response.ok) {
      console.log(`已创建提醒: ${todo.id}`);
      return true;
    } else {
      console.error(`创建提醒失败: ${response.status}`);
      return false;
    }
  } catch (e) {
    console.error(`创建提醒异常: ${e.message}`);
    return false;
  }
}

// 主函数
export default {
  async scheduled(event, env, ctx) {
    console.log('开始检查待办提醒...');
    
    try {
      // 查询需要提醒的待办（提前1小时内到期，已设置提醒且未通知）
      const now = new Date();
      const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      
      const todos = await supabaseQuery(
        `todos?select=*&remind_at=lte.${oneHourLater}&remind_at=gte.${now.toISOString()}&notified=eq.false&completed=eq.false`
      );
      
      if (!todos || todos.length === 0) {
        console.log('没有需要提醒的待办');
        return;
      }
      
      console.log(`找到 ${todos.length} 个待办需要提醒`);
      
      for (const todo of todos) {
        const success = await createOpenClawReminder(todo);
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
  
  // HTTP 处理（可选，用于手动触发测试）
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // 手动触发检查
    if (request.method === 'POST' && new URL(request.url).pathname === '/check') {
      await this.scheduled(null, env, null);
      return new Response(JSON.stringify({ success: true, message: '检查完成' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
};
