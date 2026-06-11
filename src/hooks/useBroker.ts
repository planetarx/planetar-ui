import { useEffect, useState } from 'react';
import { broker } from '@/lib/broker';

export function useBrokerStatus(): 'connecting' | 'open' | 'closed' {
  const [status, setStatus] = useState(broker.getStatus());
  useEffect(() => broker.onStatus(setStatus), []);
  return status;
}

export function useBroker() {
  const status = useBrokerStatus();
  return {
    status,
    connected: status === 'open',
    publish: broker.publish.bind(broker),
  };
}
