// Steady arrival rate on /api/users, so outages show up as failed requests.
import http from 'k6/http';

export const options = {
  scenarios: {
    users: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      // Enough VUs for 30 s hangs at 50 req/s; starting VUs mid-run drops requests.
      preAllocatedVUs: 1500,
      maxVUs: 3000,
    },
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  // Longer than nginx's 60 s upstream timeout, so hung requests stay visible.
  http.get(`${__ENV.BASE || 'http://localhost:8080'}/api/users`, { timeout: '70s' });
}
