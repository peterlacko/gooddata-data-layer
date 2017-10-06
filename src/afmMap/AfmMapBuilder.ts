import compact = require('lodash/compact');
import flow = require('lodash/flow');
import isEmpty = require('lodash/isEmpty');
import uniq = require('lodash/uniq');
import flatMap = require('lodash/flatMap');
import flatten = require('lodash/flatten');
import { IAfm, IDateFilter } from '../interfaces/Afm';
import { areUris } from '../helpers/uri';
import { DateFilterMap, IAttributeElement, IDateFilterRefData } from './DateFilterMap';
import { AttributeMap } from './AttributeMap';
import {
    getGlobalDateFilters, getMeasureDateFilters, getDateDatasetUris,
    hasFilters, isAbsoluteDateFilter, isAttributeFilter,
    isPoP, isShowInPercent
} from '../utils/AfmUtils';
import { IGoodDataSDK } from '../interfaces/GoodDataSDK';

export class AfmMapBuilder {
    sdk: IGoodDataSDK;
    projectId: string;

    constructor(sdk: IGoodDataSDK, projectId: string) {
        this.sdk = sdk;
        this.projectId = projectId;
    }

    public build(afm: IAfm): Promise<[AttributeMap, DateFilterMap]> {
        const promises: [Promise<AttributeMap>, Promise<DateFilterMap>] = [
            this.buildAttributeMap(afm),
            this.buildDateFilterMap(afm)
        ];

        return Promise.all(promises);
    }

    public buildAttributeMap(afm: IAfm): Promise<AttributeMap> {
        const attributes = lookupAttributes(afm);

        if (isEmpty(attributes)) {
            return Promise.resolve([]);
        }

        const loadAttributeUris = areUris(attributes)
            ? Promise.resolve(attributes)
            : this.sdk.md.getUrisFromIdentifiers(this.projectId, attributes)
                .then(pairs => pairs.map(pair => pair.uri));

        return loadAttributeUris.then((objectUris) => {
            return this.sdk.md.getObjects(this.projectId, objectUris)
                .then(items => items.map(item => ({
                    attribute: item.attributeDisplayForm.content.formOf,
                    attributeDisplayForm: areUris(attributes) ?
                        item.attributeDisplayForm.meta.uri :
                        item.attributeDisplayForm.meta.identifier
                })));
        });
    }

    public buildDateFilterMap(afm: IAfm): Promise<DateFilterMap> {
        const dateFilters = getMeasureDateFilters(afm);
        if (isEmpty(dateFilters)) {
            return Promise.resolve([]);
        }

        const globalDateFilters = getGlobalDateFilters(afm);
        if (!isEmpty(globalDateFilters)) {
            dateFilters.push(...globalDateFilters);
        }

        const dataSetUris = getDateDatasetUris(afm);

        return this.sdk.md.getObjects(this.projectId, dataSetUris)
            .then((dataSets) => {

                const dateAttributesPromises = dataSets.map((dataSetObject) => {
                    const dateAttributes = dataSetObject.dataSet.content.attributes;
                    return Promise.all([
                        this.sdk.md.getObjects(this.projectId, dateAttributes),
                        Promise.resolve(dataSetObject)
                    ]);
                });

                return Promise.all(dateAttributesPromises);
            })
            .then((results) => {
                const dateRefDataPromises =
                    flatMap(results, (result) => {
                        const dateAttributeObjects = result[0];
                        const dataSet = result[1];

                        return dateAttributeObjects.map(dateAttribute =>
                            this.buildDateRefData(dateAttribute, dateFilters, dataSet));
                    });

                return Promise.all(dateRefDataPromises);
            });
    }

    public buildDateRefData(
        dateAttribute,
        dateFilters: IDateFilter[],
        dataSet
    ): Promise<IDateFilterRefData> {
        const refData: IDateFilterRefData = {
            dateDataSetId: dataSet.dataSet.meta.uri,
            dateAttributeType: dateAttribute.attribute.content.type,
            dateAttributeUri: dateAttribute.attribute.meta.uri,
            dateDisplayFormUri: null,
            attributeElements: []
        };

        const dateDisplayFormUri = getDefaultDateDisplayForm(dateAttribute);
        if (dateDisplayFormUri) {
            const elementsLabels = getAbsoluteFiltersElementsLabels(dateFilters, dateDisplayFormUri);
            if (elementsLabels.length > 0) {
                return this.buildAttributeElements(elementsLabels, dateDisplayFormUri)
                    .then((elements) => {
                        refData.dateDisplayFormUri = dateDisplayFormUri;
                        refData.attributeElements = elements;
                        return Promise.resolve(refData);
                    });
            }
        }

        return Promise.resolve(refData);
    }

    public buildAttributeElements(
        elementsLabels: string[],
        displayFormUri: string
    ): Promise<IAttributeElement[]> {
        return this.sdk.md.translateElementLabelsToUris(this.projectId, displayFormUri, elementsLabels)
            .then((elementLabelUri) => {
                const results = elementLabelUri[0].result;
                const attributeElements = elementsLabels.map((elementLabel): IAttributeElement => {
                    const elementResult = results.find(result => result.pattern === elementLabel);
                    return {
                        label: elementResult.elementLabels[0].elementLabel,
                        uri: elementResult.elementLabels[0].uri
                    };
                });

                return Promise.resolve(attributeElements);
            });
    }
}

export function lookupAttributes(afm) {
    const attributes = afm.measures.map((measure) => {
        const ids = [];
        if (isPoP(measure)) { // MAQL - FOR PREVIOUS ([attributeUri]) OR ({attributeId})
            ids.push(measure.definition.popAttribute.id);
        }

        if (isShowInPercent(measure)) { // MAQL - BY ALL [attributeUri1], ALL [attributeUri2] OR ALL {attributeId2}
            ids.push(...afm.attributes.map(attribute => attribute.id));
        }

        if (hasFilters(measure)) {
            ids.push(...measure.definition.filters
                .filter(isAttributeFilter)
                .map(filter => filter.id));
        }

        return ids;
    });

    return flow(
        flatten,
        compact,
        uniq
    )(attributes);
}

function getDefaultDateDisplayForm(dateAttribute): string {
    const defaultDisplayForm = dateAttribute.attribute.content.displayForms
        .find(displayForm => displayForm.content.type === 'GDC.time.day');
    return (defaultDisplayForm) ? defaultDisplayForm.meta.uri : null;
}

function getAbsoluteFiltersElementsLabels(dateFilters: IDateFilter[], displayFormUri: string): string[] {
    const betweenStrings = dateFilters.filter(isAbsoluteDateFilter)
        .map((filter) => {
            return filter.between as [string, string];
        });

    return flow(flatten, uniq)(betweenStrings);
}
