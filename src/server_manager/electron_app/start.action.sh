#!/bin/bash -eu
#
# Copyright 2018 The Outline Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

run_action buid  server_manager/electron_app

readonly NODE_MODULES_BIN_DIR="${ROOT_DIR}/src/server_manager/node_modules/.bin"

cd "${BUILD_DIR}/server_manager/electron_app/static"
OUTLINE_DEBUG='true' \
SB_METRICS_URL='https://dev.metrics.getoutline.org' \
"${NODE_MODULES_BIN_DIR}/electron" .
