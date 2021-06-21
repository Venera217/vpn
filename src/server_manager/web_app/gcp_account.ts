// Copyright 2021 The Outline Authors
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

import * as gcp_api from '../cloud/gcp_api';
import {sleep} from '../infrastructure/sleep';
import {SCRIPT} from '../install_scripts/gcp_install_script';
import * as gcp from '../model/gcp';
import {BillingAccount, Project} from '../model/gcp';
import * as server from '../model/server';

import {GcpServer} from './gcp_server';

/** Returns a unique, RFC1035-style name as required by GCE. */
function makeInstanceName(): string {
  const now = new Date();
  return `outline-${now.getFullYear()}${now.getMonth()}${now.getDate()}-${now.getUTCHours()}${
      now.getUTCMinutes()}${now.getUTCSeconds()}`;
}
  
/**
 * The Google Cloud Platform account model.
 */
export class GcpAccount implements gcp.Account {
  private static readonly OUTLINE_PROJECT_NAME = 'Outline servers';
  private static readonly OUTLINE_FIREWALL_NAME = 'outline';
  private static readonly OUTLINE_FIREWALL_TAG = 'outline';
  private static readonly MACHINE_SIZE = 'f1-micro';
  private static readonly REQUIRED_GCP_SERVICES = ['compute.googleapis.com'];

  private readonly apiClient: gcp_api.RestApiClient;

  constructor(private id: string, private refreshToken: string) {
    this.apiClient = new gcp_api.RestApiClient(refreshToken);
  }

  getId(): string {
    return this.id;
  }

  /** @see {@link Account#getName}. */
  async getName(): Promise<string> {
    const userInfo = await this.apiClient.getUserInfo();
    return userInfo?.email;
  }

  /** Returns the refresh token. */
  getRefreshToken(): string {
    return this.refreshToken;
  }

  /** @see {@link Account#createServer}. */
  async createServer(projectId: string, description: string, zoneId: string):
      Promise<server.ManagedServer> {
    const {instanceId, name, completion} =
        await this.createInstance(projectId, description, zoneId);
    const locator = {projectId, zoneId, instanceId};
    return new GcpServer(this.id, locator, name, completion, this.apiClient);
  }

  /** @see {@link Account#listServers}. */
  async listServers(projectId: string): Promise<server.ManagedServer[]> {
    const result: GcpServer[] = [];
    const listZonesResponse = await this.apiClient.listZones(projectId);
    const listInstancesPromises = [];
    for (const zone of listZonesResponse.items) {
      const filter = 'labels.outline=true';
      const listInstancesPromise = this.apiClient.listInstances(projectId, zone.name, filter);
      listInstancesPromises.push(listInstancesPromise);
    }
    const listInstancesResponses = await Promise.all(listInstancesPromises);
    for (const response of listInstancesResponses) {
      const instances = response.items ?? [];
      instances.forEach((instance) => {
        const zoneId = instance.zone.substring(instance.zone.lastIndexOf('/') + 1);
        const locator = {projectId, zoneId, instanceId: instance.id};
        result.push(new GcpServer(this.id, locator, instance.name, Promise.resolve(), this.apiClient));
      });
    }
    return result;
  }

  /** @see {@link Account#listLocations}. */
  async listLocations(projectId: string): Promise<gcp.ZoneMap> {
    const listZonesResponse = await this.apiClient.listZones(projectId);
    const zones = listZonesResponse.items ?? [];

    const result: gcp.ZoneMap = {};
    zones.map((zone) => {
      const region = zone.region.substring(zone.region.lastIndexOf('/') + 1);
      if (!(region in result)) {
        result[region] = [];
      }
      if (zone.status === 'UP') {
        result[region].push(zone.name);
      }
    });
    return result;
  }

  /** @see {@link Account#listProjects}. */
  async listProjects(): Promise<Project[]> {
    const filter = 'labels.outline=true AND lifecycleState=ACTIVE';
    const response = await this.apiClient.listProjects(filter);
    if (response.projects?.length > 0) {
      return response.projects.map(project => {
        return {
          id: project.projectId,
          name: project.name,
        };
      });
    }
    return [];
  }

  /** @see {@link Account#createProject}. */
  async createProject(projectId: string, billingAccountId: string): Promise<Project> {
    // Create GCP project
    const createProjectData = {
      projectId,
      name: GcpAccount.OUTLINE_PROJECT_NAME,
      labels: {
        outline: 'true',
      },
    };
    const createProjectResponse = await this.apiClient.createProject(projectId, createProjectData);
    let createProjectOperation = null;
    while (!createProjectOperation?.done) {
      await sleep(2 * 1000);
      createProjectOperation =
          await this.apiClient.resourceManagerOperationGet(createProjectResponse.name);
    }
    if (createProjectOperation.error) {
      // TODO: Throw error. The project wasn't created so we should have nothing to delete.
    }

    await this.configureProject(projectId, billingAccountId);

    return {
      id: projectId,
      name: GcpAccount.OUTLINE_PROJECT_NAME,
    };
  }

  async isProjectHealthy(projectId: string): Promise<boolean> {
    const projectBillingInfo = await this.apiClient.getProjectBillingInfo(projectId);
    if (!projectBillingInfo.billingEnabled) {
      return false;
    }

    const listEnabledServicesResponse = await this.apiClient.listEnabledServices(projectId);
    for (const requiredService of GcpAccount.REQUIRED_GCP_SERVICES) {
      const found = listEnabledServicesResponse.services.find(
          service => service.config.name === requiredService);
      if (!found) {
        return false;
      }
    }

    return true;
  }

  async repairProject(projectId: string, billingAccountId: string): Promise<void> {
    return await this.configureProject(projectId, billingAccountId);
  }

  /** @see {@link Account#listBillingAccounts}. */
  async listOpenBillingAccounts(): Promise<BillingAccount[]> {
    const response = await this.apiClient.listBillingAccounts();
    if (response.billingAccounts?.length > 0) {
      return response.billingAccounts
          .filter(billingAccount => billingAccount.open)
          .map(billingAccount => ({
        id: billingAccount.name.substring(billingAccount.name.lastIndexOf('/') + 1),
        name: billingAccount.displayName,
      }));
    }
    return [];
  }

  private async createFirewallIfNeeded(projectId: string) : Promise<void> {
    // Configure Outline firewall
    const getFirewallResponse =
        await this.apiClient.listFirewalls(projectId, GcpAccount.OUTLINE_FIREWALL_NAME);
    if (!getFirewallResponse?.items || getFirewallResponse?.items?.length === 0) {
      const createFirewallData = {
        name: GcpAccount.OUTLINE_FIREWALL_NAME,
        direction: 'INGRESS',
        priority: 1000,
        targetTags: [GcpAccount.OUTLINE_FIREWALL_TAG],
        allowed: [
          {
            IPProtocol: 'all',
          },
        ],
        sourceRanges: ['0.0.0.0/0'],
      };
      const createFirewallOperation = await this.apiClient.createFirewall(projectId, createFirewallData);
      if (createFirewallOperation.error?.errors) {
        // TODO: Throw error.
      }
    }
  }

  private async createInstance(projectId: string, description: string, zoneId: string):
      Promise<{instanceId: string, name: string, completion: Promise<void>}> {

    // Create VM instance
    const name = makeInstanceName();
    const createInstanceData = {
      name,
      description,
      machineType: `zones/${zoneId}/machineTypes/${GcpAccount.MACHINE_SIZE}`,
      disks: [
        {
          boot: true,
          initializeParams: {
            sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-1804-lts',
          },
        },
      ],
      networkInterfaces: [
        {
          network: 'global/networks/default',
          // Empty accessConfigs necessary to allocate ephemeral IP
          accessConfigs: [{}],
        },
      ],
      labels: {
        outline: 'true',
      },
      tags: {
        // This must match the firewall target tag.
        items: [GcpAccount.OUTLINE_FIREWALL_TAG],
      },
      metadata: {
        items: [
          {
            key: 'enable-guest-attributes',
            value: 'TRUE',
          },
          {
            key: 'user-data',
            value: this.getInstallScript(),
          },
        ],
      },
    };
    const operation =
        await this.apiClient.createInstance(projectId, zoneId, createInstanceData);

    const instanceId = operation.targetId;
    const completion: Promise<void> = Promise.all([
      this.apiClient.computeEngineOperationZoneWait(projectId, zoneId, operation.name).then(() => {
        return this.promoteEphemeralIpIfNeeded({projectId, zoneId, instanceId});
      }),
      this.createFirewallIfNeeded(projectId)
    ]).then();

    return {instanceId, name, completion};
  }

  private async promoteEphemeralIpIfNeeded(locator: gcp_api.InstanceLocator) : Promise<void> {
    const instance = await this.apiClient.getInstance(locator);
    // Promote ephemeral IP to static IP
    const ipAddress = instance.networkInterfaces[0].accessConfigs[0].natIP;
    const createStaticIpData = {
      name: instance.name,
      description: instance.description,
      address: ipAddress,
    };
    const createStaticIpOperation = await this.apiClient.createStaticIp(
        locator.projectId, gcp.getRegionId(locator.zoneId), createStaticIpData);
    if (createStaticIpOperation.error?.errors) {
      // TODO: Delete VM instance. Throw error.
    }
  }

  private async configureProject(projectId: string, billingAccountId: string): Promise<void> {
    // Link billing account
    const updateProjectBillingInfoData = {
      name: `projects/${projectId}/billingInfo`,
      projectId,
      billingAccountName: `billingAccounts/${billingAccountId}`,
    };
    await this.apiClient.updateProjectBillingInfo(projectId, updateProjectBillingInfoData);

    // Enable APIs
    const enableServicesData = {
      serviceIds: GcpAccount.REQUIRED_GCP_SERVICES,
    };
    const enableServicesResponse =
        await this.apiClient.enableServices(projectId, enableServicesData);
    let enableServicesOperation = null;
    while (!enableServicesOperation?.done) {
      await sleep(2 * 1000);
      enableServicesOperation =
          await this.apiClient.serviceUsageOperationGet(enableServicesResponse.name);
    }
    if (enableServicesResponse.error) {
      // TODO: Throw error.
    }
  }

  private getInstallScript(): string {
    // TODO: Populate SB_DEFAULT_SERVER_NAME and other environment variables.
    return '#!/bin/bash -eu\n' + SCRIPT;
  }
}
