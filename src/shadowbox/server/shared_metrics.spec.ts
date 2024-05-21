// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as uuidv4 from 'uuid/v4';

import {ManualClock} from '../infrastructure/clock';
import {InMemoryConfig} from '../infrastructure/json_config';
import {DataLimit} from '../model/access_key';
import * as version from './version';
import {AccessKeyConfigJson} from './server_access_key';

import {ServerConfigJson} from './server_config';
import {
  LocationUsage,
  DailyFeatureMetricsReportJson,
  HourlyServerMetricsReportJson,
  MetricsCollectorClient,
  OutlineSharedMetricsPublisher,
  SharedMetricsPublisher,
  UsageMetrics,
  PrometheusUsageMetrics,
} from './shared_metrics';
import {PrometheusClient, QueryResultData} from '../infrastructure/prometheus_scraper';

describe('OutlineSharedMetricsPublisher', () => {
  let clock: ManualClock;
  let startTime: number;
  let serverConfig: InMemoryConfig<ServerConfigJson>;
  let keyConfig: InMemoryConfig<AccessKeyConfigJson>;
  let usageMetrics: ManualUsageMetrics;
  let metricsCollector: FakeMetricsCollector;
  let publisher: SharedMetricsPublisher;

  beforeEach(() => {
    clock = new ManualClock();
    startTime = clock.nowMs;
    serverConfig = new InMemoryConfig({serverId: 'server-id'});
    keyConfig = new InMemoryConfig<AccessKeyConfigJson>({
      accessKeys: [makeKeyJson({bytes: 2}), makeKeyJson()],
    });
    usageMetrics = new ManualUsageMetrics();
    metricsCollector = new FakeMetricsCollector();
    publisher = new OutlineSharedMetricsPublisher(
      clock,
      serverConfig,
      keyConfig,
      usageMetrics,
      metricsCollector
    );
  });

  describe('Enable/Disable', () => {
    it('Mirrors config', () => {
      expect(publisher.isSharingEnabled()).toBeFalse();

      publisher.startSharing();
      expect(publisher.isSharingEnabled()).toBeTrue();
      expect(serverConfig.mostRecentWrite.metricsEnabled).toBeTrue();

      publisher.stopSharing();
      expect(publisher.isSharingEnabled()).toBeFalse();
      expect(serverConfig.mostRecentWrite.metricsEnabled).toBeFalse();
    });

    it('Reads from config', () => {
      serverConfig.data().metricsEnabled = true;

      expect(publisher.isSharingEnabled()).toBeTrue();
    });
  });

  describe('reporting', () => {
    beforeEach(() => {
      publisher.startSharing();
    });

    afterEach(() => {
      publisher.stopSharing();
    });

    describe('for server usage', () => {
      it('is sending correct reports', async () => {
        usageMetrics.locationUsage = [
          {country: 'AA', inboundBytes: 11, tunnelTimeSec: 99},
          {country: 'BB', inboundBytes: 11, tunnelTimeSec: 88},
          {country: 'CC', inboundBytes: 22, tunnelTimeSec: 77},
          {country: 'AA', inboundBytes: 33, tunnelTimeSec: 66},
          {country: 'DD', inboundBytes: 33, tunnelTimeSec: 55},
        ];
        clock.nowMs += 60 * 60 * 1000;

        await clock.runCallbacks();

        expect(metricsCollector.collectedServerUsageReport).toEqual({
          serverId: 'server-id',
          startUtcMs: startTime,
          endUtcMs: clock.nowMs,
          userReports: [
            {bytesTransferred: 11, tunnelTimeSec: 99, countries: ['AA']},
            {bytesTransferred: 11, tunnelTimeSec: 88, countries: ['BB']},
            {bytesTransferred: 22, tunnelTimeSec: 77, countries: ['CC']},
            {bytesTransferred: 33, tunnelTimeSec: 66, countries: ['AA']},
            {bytesTransferred: 33, tunnelTimeSec: 55, countries: ['DD']},
          ],
        });
      });

      it('sends ASN data if present', async () => {
        usageMetrics.locationUsage = [
          {country: 'DD', asn: 999, inboundBytes: 44, tunnelTimeSec: 11},
          {country: 'EE', inboundBytes: 55, tunnelTimeSec: 22},
        ];
        clock.nowMs += 60 * 60 * 1000;

        await clock.runCallbacks();

        expect(metricsCollector.collectedServerUsageReport.userReports).toEqual([
          {bytesTransferred: 44, tunnelTimeSec: 11, countries: ['DD'], asn: 999},
          {bytesTransferred: 55, tunnelTimeSec: 22, countries: ['EE']},
        ]);
      });

      it('resets metrics to avoid double reporting', async () => {
        usageMetrics.locationUsage = [
          {country: 'AA', inboundBytes: 11, tunnelTimeSec: 77},
          {country: 'BB', inboundBytes: 11, tunnelTimeSec: 88},
        ];
        clock.nowMs += 60 * 60 * 1000;
        startTime = clock.nowMs;
        await clock.runCallbacks();
        usageMetrics.locationUsage = [
          ...usageMetrics.locationUsage,
          {country: 'CC', inboundBytes: 22, tunnelTimeSec: 99},
          {country: 'DD', inboundBytes: 22, tunnelTimeSec: 0},
        ];
        clock.nowMs += 60 * 60 * 1000;

        await clock.runCallbacks();

        expect(metricsCollector.collectedServerUsageReport.userReports).toEqual([
          {bytesTransferred: 22, tunnelTimeSec: 99, countries: ['CC']},
          {bytesTransferred: 22, tunnelTimeSec: 0, countries: ['DD']},
        ]);
      });

      it('ignores sanctioned countries', async () => {
        usageMetrics.locationUsage = [
          {country: 'AA', inboundBytes: 11, tunnelTimeSec: 1},
          {country: 'SY', inboundBytes: 11, tunnelTimeSec: 2},
          {country: 'CC', inboundBytes: 22, tunnelTimeSec: 3},
          {country: 'AA', inboundBytes: 33, tunnelTimeSec: 4},
          {country: 'DD', inboundBytes: 33, tunnelTimeSec: 5},
        ];
        clock.nowMs += 60 * 60 * 1000;

        await clock.runCallbacks();

        expect(metricsCollector.collectedServerUsageReport.userReports).toEqual([
          {bytesTransferred: 11, tunnelTimeSec: 1, countries: ['AA']},
          {bytesTransferred: 22, tunnelTimeSec: 3, countries: ['CC']},
          {bytesTransferred: 33, tunnelTimeSec: 4, countries: ['AA']},
          {bytesTransferred: 33, tunnelTimeSec: 5, countries: ['DD']},
        ]);
      });
    });

    describe('for feature metrics', () => {
      it('is sending correct reports', async () => {
        await clock.runCallbacks();

        expect(metricsCollector.collectedFeatureMetricsReport).toEqual({
          serverId: 'server-id',
          serverVersion: version.getPackageVersion(),
          timestampUtcMs: startTime,
          dataLimit: {
            enabled: false,
            perKeyLimitCount: 1,
          },
        });
      });

      it('reports global data limits', async () => {
        serverConfig.data().accessKeyDataLimit = {bytes: 123};

        await clock.runCallbacks();

        expect(metricsCollector.collectedFeatureMetricsReport.dataLimit.enabled).toBeTrue();
        expect(metricsCollector.collectedFeatureMetricsReport.dataLimit.perKeyLimitCount).toEqual(
          1
        );
      });

      it('reports per-key data limit count', async () => {
        delete keyConfig.data().accessKeys[0].dataLimit;

        await clock.runCallbacks();

        expect(metricsCollector.collectedFeatureMetricsReport.dataLimit.perKeyLimitCount).toEqual(
          0
        );
      });
    });
  });

  it('does not report metrics when sharing is disabled', async () => {
    spyOn(metricsCollector, 'collectServerUsageMetrics').and.callThrough();
    spyOn(metricsCollector, 'collectFeatureMetrics').and.callThrough();
    serverConfig.data().metricsEnabled = false;

    await clock.runCallbacks();

    expect(metricsCollector.collectServerUsageMetrics).not.toHaveBeenCalled();
    expect(metricsCollector.collectFeatureMetrics).not.toHaveBeenCalled();
  });
});

describe('PrometheusUsageMetrics', () => {
  let prometheusClient: jasmine.SpyObj<PrometheusClient>;
  let publisher: PrometheusUsageMetrics;

  beforeEach(() => {
    prometheusClient = jasmine.createSpyObj('PrometheusClient', ['query']);
    publisher = new PrometheusUsageMetrics(prometheusClient);
  });

  it('returns a list of location usage', async () => {
    const mockDataBytesResponse: QueryResultData = {
      resultType: 'vector',
      result: [
        {
          metric: {location: 'US', asn: '15169'},
          value: [Date.now() / 1000, '123'],
        },
        {
          metric: {location: 'NL', asn: '1136'},
          value: [Date.now() / 1000, '456'],
        },
      ],
    };
    const mockTunnelTimeResponse: QueryResultData = {
      resultType: 'vector',
      result: [
        {
          metric: {location: 'US', asn: '15169'},
          value: [Date.now() / 1000, '9999'],
        },
        {
          metric: {location: 'FR'},
          value: [Date.now() / 1000, '8888'],
        },
      ],
    };
    prometheusClient.query.and.returnValues(
      Promise.resolve(mockDataBytesResponse),
      Promise.resolve(mockTunnelTimeResponse)
    );

    const observedUsage = await publisher.getLocationUsage();

    expect(observedUsage).toEqual([
      {country: 'US', asn: 15169, inboundBytes: 123, tunnelTimeSec: 9999},
      {country: 'NL', asn: 1136, inboundBytes: 456, tunnelTimeSec: 0},
      {country: 'FR', asn: undefined, inboundBytes: 0, tunnelTimeSec: 8888},
    ]);
  });

  it('returns an empty list when there is no location usage', async () => {
    prometheusClient.query.and.returnValue(
      Promise.resolve({
        resultType: 'vector',
        result: [],
      })
    );

    expect(await publisher.getLocationUsage()).toEqual([]);
  });
});

class FakeMetricsCollector implements MetricsCollectorClient {
  public collectedServerUsageReport: HourlyServerMetricsReportJson;
  public collectedFeatureMetricsReport: DailyFeatureMetricsReportJson;

  async collectServerUsageMetrics(report) {
    this.collectedServerUsageReport = report;
  }

  async collectFeatureMetrics(report) {
    this.collectedFeatureMetricsReport = report;
  }
}

class ManualUsageMetrics implements UsageMetrics {
  public locationUsage = [] as LocationUsage[];

  getLocationUsage(): Promise<LocationUsage[]> {
    return Promise.resolve(this.locationUsage);
  }

  reset() {
    this.locationUsage = [] as LocationUsage[];
  }
}

function makeKeyJson(dataLimit?: DataLimit) {
  return {
    id: uuidv4(),
    name: 'name',
    password: 'pass',
    port: 12345,
    dataLimit,
  };
}
