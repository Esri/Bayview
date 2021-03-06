/*    Copyright 2017 Esri

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License. */

define([
  'dojo/_base/declare',
  'dijit/_WidgetBase',
  'dijit/_TemplatedMixin',
  'dijit/_WidgetsInTemplateMixin',
  'dojo/Evented',

  'dojo/_base/lang',
  'dojo/_base/connect',
  'dojo/topic',
  'dojo/parser',
  'dojo/query',
  'dojo/on',
  'dojo/dom-style',
  'dojo/dom-class',
  'dojo/dom-attr',
  'dojo/dom-construct',
  'dijit/registry',

  'widget/DrawTool',
  'widget/ExtractData/LayerItem',

  'core/layerUtils',

  'esri/tasks/Geoprocessor',
  'esri/tasks/FeatureSet',
  'esri/graphic',
  'esri/domUtils',

  'dojo/text!./ExtractData/ExtractData.html'
],

function(
  declare, WidgetBase, TemplatedMixin, WidgetsInTemplateMixin,
  Evented,
  lang, connect, topic, parser, query, on, domStyle, domClass, domAttr, domConstruct, registry,
  DrawTool, LayerItem,
  layerUtils,
  Geoprocessor, FeatureSet, Graphic, domUtils,
  template
) {

  return declare([WidgetBase, TemplatedMixin, WidgetsInTemplateMixin, Evented], {

    templateString: template,
    widgetsInTemplate: true,

    constructor: function() {
      this.AOI = null;
      this.gp = null;
      this.clipLayers = [];
      this.isLayersOpen = false;
    },

    postCreate: function() {
      this.inherited(arguments);

      if (this.map) {
        // hookup the draw tools
        var drawConfig = lang.mixin(this.config.parameters.areaOfInterest.drawOptions, {
            container: 'extract'
          });
        this.drawTool = new DrawTool({
          map: this.map,
          drawConfig: drawConfig
        }, this.drawToolContainer);
        this.drawTool.startup();
        this.own(on(this.drawTool, 'ended', lang.hitch(this, function(geometry) {
          this._updateAOI(geometry);
        })));

        // initialize the GP task
        this.gpTask = new Geoprocessor(this.config.taskUrl);
        this.gpTask.setOutSpatialReference(this.map.extent.spatialReference);

        // attach event listeners
        this.own(on(this.btnExtract, 'click', lang.hitch(this, this._btnExtractClicked)));
        this.own(on(this.btnClear, 'click', lang.hitch(this, this._btnClearClicked)));

        // populate the layers
        this.own(on(this.map, 'layers-add-result', lang.hitch(this, this._populateLayers)));

        this.own(on(this.layersToggle, 'click', lang.hitch(this, this._toggleLayersClicked)));

        this._reset();
      } else {
        console.error('ExtractData widget: no map defined!');
      }
    },

    startup: function() {
      //console.log('ExtractData tool loaded.');

      // Start the tool hidden
      this.hide();

      this.own(on(this.closeBtn, 'click', lang.hitch(this, function() {
          //this.clearResult();
          //this.setTool(null);
          this.hide();
      })));
    },

    _populateLayers: function(results) {
      this.layerItems = [];
      var layers = _.sortBy(results.layers, function(layer) { return layer.layer.name; });
      _.each(layers, lang.hitch(this, function(result) {
        var layerDef = layerUtils.getLayerInfo(this.map, result.layer.id);
        var lt = new LayerItem({
          map: this.map,
          layerDef: layerDef
        }).placeAt(this.layersContainer);
        this.own(on(lt, 'changed', lang.hitch(this, function(args) {
          this._updateLayersCount();
        })));
        this.layerItems.push(lt);
      }));
      this._updateLayersCount();
    },

    _updateAOI: function(geometry) {
      this.AOI = geometry;
    },

    _btnExtractClicked: function() {
      // LAYERS
      this.clipLayers.length = 0;
      _.each(registry.findWidgets(this.layersContainer), lang.hitch(this, function(layerItem) {
        if (layerItem.isChecked()) {
          this.clipLayers.push(layerItem.getLayerId());
        }
      }));

      if (this.clipLayers.length === 0) {
        this._showMessage('Select at least 1 layer');
        var isLayersOpen = true;
        this._toggleLayers(isLayersOpen);
        return;
      }

      // AOI
      if (this.AOI === null) {
        this._showMessage('Use the draw tool to define the area to download.');
        return;
      }
      var featureSet = new FeatureSet();
      var features = [];
      features.push(new Graphic(this.AOI));
      featureSet.features = features;

      // FORMAT
      var format = 'Shapefile - SHP - .shp';

      // define the GP task parameters
      var params = {
        'Layers_to_Clip': this.clipLayers,
        'Area_of_Interest': featureSet,
        'Feature_Format': format
      };

      // run the GP task
      this.gpTask.submitJob(params,
        lang.hitch(this, this._submitJobCompleted),
        lang.hitch(this, this._submitJobStatus),
        lang.hitch(this, this._submitJobError));

      // show loading message
      this._showMessage();

      // close the layer list
      var isOpen = false;
      this._toggleLayers(isOpen);
    },

    _btnClearClicked: function() {
      this.drawTool._clearGraphics();
    },

    _submitJobCompleted: function(jobInfo) {
      if (jobInfo.jobStatus !== 'esriJobFailed') {
        this.gpTask.getResultData(jobInfo.jobId, 'Output_Zip_File', lang.hitch(this, this._getResultDataSuccess));
      }
    },

    _submitJobStatus: function(jobInfo) {
      var status = jobInfo.jobStatus;
      if (status === 'esriJobFailed') {
        console.log('Error in GP task (status): ', status);
        // TODO: show status error msg
        this._hideMessage();
      } else if (status === 'esriJobSucceeded') {
        this._hideMessage();
      }
    },

    _submitJobError: function(error) {
      console.log('Error in GP task: ', error);
      // TODO: show status error msg
      this._hideMessage();
    },

    _getResultDataSuccess: function(outputFile) {
      // clear the graphics
      this.drawTool._clearGraphics();

      // set the download url
      var downloadUrl = outputFile.value.url;
      this.lnkDownload.href = downloadUrl;

      // show the download panel
      this._hideMessage();
      domClass.remove(this.resultPanelContainer, 'hidden');
    },

    _showMessage: function(msg) {
      var message = msg || 'Processing your extract request...';
      this.messageContent.innerHTML = message;
      domClass.remove(this.messagePanelContainer, 'hidden');
    },

    _hideMessage: function() {
      domClass.add(this.messagePanelContainer, 'hidden');
    },

    _toggleLayersClicked: function(evt) {
      this._toggleLayers();
    },

    _toggleLayers: function(open) {
      this.isLayersOpen = _.isUndefined(open) ? !this.isLayersOpen : open;
      if (this.isLayersOpen) {
        domClass.remove(this.layersContainer, 'hidden');
        this.layersToggle.innerHTML = 'hide layers';
      } else {
        domClass.add(this.layersContainer, 'hidden');
        this.layersToggle.innerHTML = 'show layers';
      }
    },

    _updateLayersCount: function() {
      var count = 0;
      _.each(registry.findWidgets(this.layersContainer), lang.hitch(this, function(layerItem) {
        if (layerItem.isChecked()) {
          count += 1;
        }
      }));
      this.countLayers.innerHTML = count;
    },

    _reset: function() {
      domClass.add(this.messagePanelContainer, 'hidden');
      domClass.add(this.resultPanelContainer, 'hidden');
      var isLayersOpen = false;
      this._toggleLayers(isLayersOpen);
      this.AOI = null;
    },

    show: function () {
      domUtils.show(this.domNode);
    },

    hide: function () {
      domUtils.hide(this.domNode);
      this.drawTool._clearGraphics();
      topic.publish('/ToolList/unselected', this, {
          type: null
      });
    }

  });
});
